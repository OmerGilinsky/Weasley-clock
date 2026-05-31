import {setGlobalOptions} from "firebase-functions";
import { onDocumentCreated, onDocumentUpdated, onDocumentDeleted} from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger"; 
import { getFirestore } from "firebase-admin/firestore";



// Get the Firestore instance to share between functions
if (admin.apps.length === 0) {
    admin.initializeApp();
}
const db = admin.firestore();

setGlobalOptions({maxInstances: 10});

/**
 * Trigger: Fires when a new user document is created
 */
export const onUserCreated = onDocumentCreated("users/{userId}",
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      logger.log("No data associated with this event");
      return;
    }

    const userId = event.params.userId;

    // Fetch raw data and safely check fullName validity
    const userData = snapshot.data();
    let finalName = userData && userData.fullName ? userData.fullName : null;

    // Protection: Validate that fullName is a valid, non-empty string
    if (!finalName || typeof finalName !== "string" || finalName.trim() === "") {
      // Log a warning in Firebase Function Logs
      logger.warn(`[Validation Warning] Document created without a valid fullName. ID: ${userId}. Fallback to 'Unknown User'.`);
      finalName = "Unknown User";
    }

    // --- Dynamic location validation against Admin GPS settings ---
    let finalLocation = userData && userData.currentLocation ? userData.currentLocation : null;
    const allowedLocationNames: string[] = [];

    try {
      // Fetch all allowed location documents from the dedicated admin collection
      const locationsSnapshot = await db.collection("locations").get();
      
      // Loop through locations and collect valid location names into the array
      locationsSnapshot.forEach((doc) => {
        const locData = doc.data();
        if (locData && locData.locationName) {
          allowedLocationNames.push(locData.locationName);
        }
      });
    } catch (err) {
      logger.error("Failed to fetch allowed locations with GPS from DB", err);
    }

    // Comparison: If the app-provided location is missing or not in Admin settings, fallback to Unknown Location
    if (!finalLocation || !allowedLocationNames.includes(finalLocation)) {
      logger.warn(`[Location Warning] User ${finalName} provided location '${finalLocation}' which is not mapped with GPS. Fallback to 'Unknown Location'.`);
      finalLocation = "Unknown Location";
    }

    try {
      await db.runTransaction(async (transaction) => {
        // Fetch all users to check hand allocation status
        const usersSnapshot = await transaction.get(db.collection("users"));

        const takenHands = new Set<number>();
        usersSnapshot.forEach((doc) => {
          // Extra protection while scanning existing users for missing fields
          const docData = doc.data();
          if (doc.id !== userId && docData && docData.handNumber) {
            takenHands.add(docData.handNumber);
          }
        });

        // Find the first available physical clock hand number
        let assignedHand: number | null = null;
        for (let i = 1; i <= 4; i++) {
          if (!takenHands.has(i)) {
            assignedHand = i;
            break;
          }
        }

        // Handle edge cases and allocate using set and merge (including protected name and location)
        if (assignedHand === null) {
          logger.log(`No hand for ${finalName} (${userId}). Waiting list.`);
          transaction.set(snapshot.ref, {
            fullName: finalName, 
            currentLocation: finalLocation, // Updates to the safe/corrected location
            handNumber: 0,
            status: "waiting_list",
          }, { merge: true });
        } else {
          logger.log(`Assigning hand ${assignedHand} to ${finalName}`);
          transaction.set(snapshot.ref, {
            fullName: finalName, 
            currentLocation: finalLocation, // Updates to the safe/corrected location
            handNumber: assignedHand,
            status: "active",
          }, { merge: true });
        }
      });

      logger.log(`Transaction completed successfully for user ${userId}`);
    } catch (error) {
      logger.error("Transaction failed critically: ", error);
    }
  }
);



/**
 * Trigger: Fires when an existing user document is updated.
 * Purpose 1: Detects location changes, fetches the matching physical clock angle, and updates targetAngle.
 * Purpose 2: Trigger Queued Messages - Checks if the user arrived "HOME" and releases relevant pending messages.
 */
export const onUserLocationChanged = onDocumentUpdated("users/{userId}", async (event) => {
    const change = event.data;
    if (!change) {
        logger.error("No data associated with the event");
        return;
    }

    const beforeData = change.before.data();
    const afterData = change.after.data();

    const beforeLocation = beforeData?.currentLocation;
    const afterLocation = afterData?.currentLocation;

    // Optimization & Cost-Savings: If the textual location hasn't changed, exit immediately
    if (beforeLocation === afterLocation) {
        logger.log(`Location did not change for user ${event.params.userId}. Skipping execution.`);
        return;
    }

    logger.log(`User ${event.params.userId} changed location from '${beforeLocation}' to '${afterLocation}'`);

    // If the new location is empty or missing, treat it as "Unknown" and set angle to 0
    if (!afterLocation) {
        logger.log("New location is empty. Setting targetAngle to default (0).");
        await change.after.ref.set({ targetAngle: 0 }, { merge: true });
        return;
    }

    try {
        // --- PART 1: Update targetAngle for the physical clock motor ---
        const locationsRef = db.collection("locations");
        const snapshot = await locationsRef.where("locationName", "==", afterLocation).get();

        let targetAngle = 0; // Default angle for unconfigured or missing locations

        if (snapshot.empty) {
            logger.warn(`Location '${afterLocation}' not found in locations collection. Using default angle 0.`);
        } else {
            const locationDoc = snapshot.docs[0].data();
            if (locationDoc.angle !== undefined) {
                targetAngle = locationDoc.angle;
                logger.log(`Found location '${afterLocation}' with angle ${targetAngle}`);
            } else {
                logger.warn(`Location '${afterLocation}' found but is missing the 'angle' field. Using 0.`);
            }
        }

        await change.after.ref.set({ targetAngle: targetAngle }, { merge: true });
        logger.log(`Successfully updated targetAngle to ${targetAngle} for user ${event.params.userId}`);

        // --- PART 2: Trigger Queued Messages On Arrival ---
        // We only check for queued messages if the user just arrived "HOME"
        if (afterLocation === "HOME") {
            const userName = afterData?.fullName;
            logger.log(`User '${userName}' arrived HOME. Checking for queued messages...`);

            // Fetch all messages that are currently waiting in the queue
            const queuedMessagesSnapshot = await db.collection("voice_messages")
                .where("status", "==", "queued")
                .get();

            if (!queuedMessagesSnapshot.empty) {
                // We use a Batch to update multiple messages simultaneously (saves performance and costs)
                const batch = db.batch();
                let messagesUpdatedCount = 0;

                queuedMessagesSnapshot.docs.forEach((msgDoc) => {
                    const msgData = msgDoc.data();
                    const targetName = msgData.targetUserName || msgData.recipientName;

                    // Condition logic: 
                    // 1. If it's a family message (no targetName), play it because ANYONE arriving should hear it.
                    // 2. If it's a personal message, play it ONLY if the targetName matches the user who just arrived.
                    if (!targetName || targetName === userName) {
                        logger.log(`Queue match found! Preparing to play message ${msgDoc.id} for ${userName || 'the family'}.`);
                        
                        // Add the update operation to the batch
                        batch.update(msgDoc.ref, { status: "ready_to_play" });
                        messagesUpdatedCount++;
                    }
                });

                // Commit the batch to the database if we found relevant messages
                if (messagesUpdatedCount > 0) {
                    await batch.commit();
                    logger.log(`Successfully triggered ${messagesUpdatedCount} queued messages for playback.`);
                } else {
                    logger.log("Queued messages exist, but none are for the user who just arrived. Keeping them queued.");
                }
            } else {
                logger.log("No queued messages found in the database. The house is clear.");
            }
        }

    } catch (error) {
        logger.error("Error fetching location, updating user document, or processing queued messages:", error);
    }
});

/**
 * Trigger: Fires when an existing user document is deleted from the "users" collection.
 * Purpose: Performs a Cascade Delete to clear Firestore documents, cleanup physical storage files, 
 * and naturally free up the physical clock hand for future users.
 */
export const onUserDeleted = onDocumentDeleted("users/{userId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        logger.error("No data associated with the deletion event");
        return;
    }

    const userId = event.params.userId;
    const userData = snapshot.data();
    const deletedHand = userData?.handNumber || 0;

    logger.log(`Starting cleanup chain for deleted user ${userId} who held clock hand #${deletedHand}`);

    try {
        // --- 1. Firestore Cascade Delete: voice_messages ---
        const voiceMessagesRef = db.collection("voice_messages");
        // Assuming messages are linked to the user via a "userId" or "senderId" field
        const voiceSnapshot = await voiceMessagesRef.where("userId", "==", userId).get();
        
        if (!voiceSnapshot.empty) {
            const batch = db.batch();
            voiceSnapshot.forEach((doc) => batch.delete(doc.ref));
            await batch.commit();
            logger.log(`Successfully deleted ${voiceSnapshot.size} voice message documents from Firestore.`);
        }

        // --- 2. Firestore Cascade Delete: visual_greetings (Doodles/Drawings) ---
        const visualGreetingsRef = db.collection("visual_greetings");
        const visualSnapshot = await visualGreetingsRef.where("userId", "==", userId).get();
        
        if (!visualSnapshot.empty) {
            const batch = db.batch();
            visualSnapshot.forEach((doc) => batch.delete(doc.ref));
            await batch.commit();
            logger.log(`Successfully deleted ${visualSnapshot.size} visual greeting documents from Firestore.`);
        }

        // --- 3. Cloud Storage Cleanup: Storage Orphan Prevention ---
        const bucket = admin.storage().bucket();
        const userAudioFolder = `audio_bites/${userId}/`;

        // Delete all physical audio files stored under this user's unique folder
        await bucket.deleteFiles({
            prefix: userAudioFolder
        });
        logger.log(`Successfully cleared physical storage files under path: '${userAudioFolder}'`);

        logger.log(`User ${userId} cleanup completed successfully. Clock hand #${deletedHand} is now fully available.`);

    } catch (error) {
        logger.error(`Critical error occurred during the cascade deletion pipeline for user ${userId}:`, error);
    }
});

/**
 * Trigger: onLocationDeleted
 * Triggers automatically when an admin deletes a location document from the "locations" collection.
 * Purpose: Cleanup/Maintenance - Updates users who are currently at the deleted location.
 */
export const onLocationDeleted = onDocumentDeleted("locations/{locationId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        logger.error("No data associated with the event");
        return;
    }

    // Extract the internal location name (e.g., "WORK") from the deleted document data
    const deletedLocationData = snapshot.data();
    const deletedLocationName = deletedLocationData?.locationName; 

    if (!deletedLocationName) {
        logger.warn(`The deleted document '${event.params.locationId}' did not contain a 'locationName' field. Cleanup aborted.`);
        return;
    }

    logger.log(`Location '${deletedLocationName}' (ID: ${event.params.locationId}) was deleted. Starting cleanup process for affected users...`);

    try {
        // 1. Query all users whose currentLocation matches the internal location name (e.g., "WORK")
        const usersSnapshot = await db.collection("users")
            .where("currentLocation", "==", deletedLocationName)
            .get();

        // If no users are currently assigned to this location, exit early and log it
        if (usersSnapshot.empty) {
            logger.log(`No users were found with currentLocation == '${deletedLocationName}'. No updates needed.`);
            return;
        }

        // 2. Initialize a Write Batch to perform multiple updates efficiently
        const batch = db.batch();

        usersSnapshot.docs.forEach((doc) => {
            logger.log(`Preparing location reset for user ID: ${doc.id}`);
            
            // Update the user fields to default values as specified in User Story 3
            batch.update(doc.ref, {
                currentLocation: "Unknown Location", // Set status to unknown since the location no longer exists
                targetAngle: 0                       // Reset motor target angle to 0 (hand pointing straight up)
            });
        });

        // 3. Commit the batch write operation to Firestore
        await batch.commit();
        logger.log(`Successfully updated ${usersSnapshot.size} users following the deletion of '${deletedLocationName}'.`);

    } catch (error) {
        logger.error("Error occurred during onLocationDeleted execution:", error);
    }
});

/**
 * Trigger: onLocationUpdated
 * Triggers automatically when an ADMIN updates an existing location document in the "locations" collection.
 * Purpose: Cascade Update - If the admin changes a location's name or angle, update all users currently at that location.
 */
export const onLocationUpdated = onDocumentUpdated("locations/{locationId}", async (event) => {
    const change = event.data;
    if (!change) {
        logger.error("No data associated with the event");
        return;
    }

    const beforeData = change.before.data();
    const afterData = change.after.data();

    // Extract values before and after the ADMIN's update
    const beforeName = beforeData?.locationName;
    const afterName = afterData?.locationName;
    const beforeAngle = beforeData?.angle;
    const afterAngle = afterData?.angle;

    // Optimization: If the admin didn't change the name or the angle, skip execution to save costs
    if (beforeName === afterName && beforeAngle === afterAngle) {
        logger.log(`No relevant changes (name or angle) for location ID: ${event.params.locationId}. Skipping execution.`);
        return;
    }

    logger.log(`Admin updated location ${event.params.locationId}. Name: '${beforeName}' -> '${afterName}', Angle: ${beforeAngle} -> ${afterAngle}`);

    if (!beforeName) {
        logger.warn("Before-image missing 'locationName'. Cannot find affected users.");
        return;
    }

    try {
        // 1. Find all family members whose currentLocation matches the OLD name (before the admin's update)
        const usersSnapshot = await db.collection("users")
            .where("currentLocation", "==", beforeName)
            .get();

        // If no family members are currently at this location, exit early
        if (usersSnapshot.empty) {
            logger.log(`No users are currently at '${beforeName}'. No updates needed.`);
            return;
        }

        // 2. Initialize a Write Batch to update all affected users at once
        const batch = db.batch();
        
        // Determine the new values to set
        const finalAngle = afterAngle !== undefined ? afterAngle : 0;
        const finalLocationName = afterName || beforeName; // If name didn't change, keep the old one

        usersSnapshot.docs.forEach((doc) => {
            logger.log(`Updating user ID: ${doc.id} due to admin location change.`);
            
            // Update the user's document with the admin's new settings
            batch.update(doc.ref, {
                currentLocation: finalLocationName,
                targetAngle: finalAngle
            });
        });

        // 3. Commit the batch write to Firestore
        await batch.commit();
        logger.log(`Successfully updated ${usersSnapshot.size} users to the new admin settings.`);

    } catch (error) {
        logger.error("Error occurred during execution of onLocationUpdated:", error);
    }
});

/**
 * Trigger: onVoiceMessageCreated
 * Triggers automatically when a new document is added to the "voice_messages" collection.
 * Purpose: Determines if the message should be played immediately or queued based on user locations.
 * Supports both family-wide messages and targeted personal messages (By User Name).
 */
export const onVoiceMessageCreated = onDocumentCreated("voice_messages/{messageId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        logger.error("No data associated with the new voice message event");
        return;
    }

    const messageData = snapshot.data();
    
    const targetUserName = messageData?.targetUserName || messageData?.recipientName; 
    
    let shouldPlayImmediately = false;

    try {
        if (targetUserName) {
            // --- Scenario A: Targeted Personal Message (By Name) ---
            logger.log(`Processing personal message for user name: ${targetUserName}`);
            
            
            const usersSnapshot = await db.collection("users")
                .where("fullName", "==", targetUserName)
                .limit(1) 
                .get();
            
            if (!usersSnapshot.empty) {
                const userData = usersSnapshot.docs[0].data();
                //CHECK IF THE TARGET IS CURRENTLY AT HOME
                if (userData?.currentLocation === "HOME") {
                    shouldPlayImmediately = true;
                    logger.log(`Target user '${targetUserName}' is at HOME. Message ready to play.`);
                } else {
                    logger.log(`Target user '${targetUserName}' is NOT at HOME (current location: ${userData?.currentLocation}). Queuing message.`);
                }
            } else {
                logger.warn(`Target user with name '${targetUserName}' not found in database. Queuing message as fallback.`);
            }

        } else {
            // --- Scenario B: General Family Message (No specific recipient) ---
            logger.log("Processing family message. Checking if anyone is at HOME.");
            
            // Check if there is at least one family member currently at "HOME"
            const usersAtHomeSnapshot = await db.collection("users")
                .where("currentLocation", "==", "HOME")
                .limit(1) 
                .get();
                
            if (!usersAtHomeSnapshot.empty) {
                shouldPlayImmediately = true;
                logger.log("At least one person is currently at HOME. Message ready to play.");
            } else {
                logger.log("The house is currently empty. Queuing message.");
            }
        }

        // --- Update Message Status in Firestore ---
        const newStatus = shouldPlayImmediately ? "ready_to_play" : "queued";
        
        await snapshot.ref.update({
            status: newStatus
        });
        
        logger.log(`Successfully updated voice message ${event.params.messageId} status to '${newStatus}'`);

    } catch (error) {
        logger.error("Error processing new voice message:", error);
    }
});

/**
 * Trigger: onVisualGreetingCreated
 * Triggers automatically when a new doodle/image is added to the "visual_greetings" collection.
 * Purpose: Finds the relevant user by NAME, logs their location, and updates their displayGreetingUrl 
 * so the physical LCD on the clock can download and show the image.
 */
export const onVisualGreetingCreated = onDocumentCreated("visual_greetings/{greetingId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        logger.error("No data associated with the new visual greeting event");
        return;
    }

    const greetingData = snapshot.data();
    
    // Locate the target user by NAME and the Storage URL of the drawing
    const targetUserName = greetingData?.targetUserName || greetingData?.recipientName; 
    const imageUrl = greetingData?.imageUrl || greetingData?.greetingUrl;

    if (!targetUserName || !imageUrl) {
        logger.warn(`Visual greeting ${event.params.greetingId} is missing targetUserName or imageUrl. Aborting execution.`);
        return;
    }

    logger.log(`Processing new visual greeting for user name: ${targetUserName}`);

    try {
        // Query the users collection to find the document with the matching fullName
        const usersSnapshot = await db.collection("users")
            .where("fullName", "==", targetUserName)
            .limit(1)
            .get();

        if (usersSnapshot.empty) {
            logger.warn(`Target user with name '${targetUserName}' not found in database.`);
            return;
        }

        // Get the first matching user document
        const userDoc = usersSnapshot.docs[0];
        const userData = userDoc.data();
        
        // As per specifications: Check and log the user's current location
        const currentLocation = userData?.currentLocation || "Unknown Location";
        logger.log(`Target user '${targetUserName}' is currently at: '${currentLocation}'. Updating LCD screen data...`);

        // Update the user's document with the new image path so the physical clock can pull it
        await userDoc.ref.update({
            displayGreetingUrl: imageUrl
        });

        logger.log(`Successfully updated displayGreetingUrl for user '${targetUserName}'. Clock LCD can now pull the image.`);

    } catch (error) {
        logger.error("Error processing visual greeting:", error);
    }
});