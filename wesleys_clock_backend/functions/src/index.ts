import {setGlobalOptions} from "firebase-functions";
import { onDocumentCreated, onDocumentUpdated, onDocumentDeleted} from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger"; 
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getMessaging } from "firebase-admin/messaging";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onRequest } from "firebase-functions/v2/https";


// Get the Firestore instance to share between functions
if (getApps().length === 0) {
    initializeApp();
}
const db = getFirestore();

setGlobalOptions({maxInstances: 10});

const ESP32_QUEUE_COLLECTION = "esp32_event_queue";
const ESP32_QUEUE_STATE_DOC = db.collection("system_status").doc("esp32_queue_state");

type Esp32QueueEventType =
    | "play_picture"
    | "play_voice"
    | "update_display"
    | "move_clock_hand"
    | "reset_screen";

interface QueueEventInput {
    eventType: Esp32QueueEventType;
    payload: Record<string, unknown>;
    userId?: string;
    handNumber?: number;
    sourceCollection?: string;
    sourceId?: string;
}

function readStringField(data: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === "string" && value.trim() !== "") {
            return value.trim();
        }
    }
    return null;
}

function readNumericField(data: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }
    return null;
}

function readLocationScreen(data: Record<string, unknown>): string | number | null {
    const screenKeys = ["screen", "screenId", "screenIndex", "display", "displayIndex", "lcd", "lcdScreen"];
    for (const key of screenKeys) {
        const value = data[key];
        if (typeof value === "number" || typeof value === "string") {
            return value;
        }
    }
    return null;
}

function readLocationSoundUrl(data: Record<string, unknown>): string | null {
    return readStringField(data, ["soundUrl", "locationSoundUrl", "audioUrl", "sound", "voiceUrl"]);
}

function readPictureUrl(data: Record<string, unknown>): string | null {
    return readStringField(data, ["imageUrl", "greetingUrl", "mediaUrl", "displayGreetingUrl", "pictureUrl"]);
}

function readAudioUrl(data: Record<string, unknown>): string | null {
    return readStringField(data, ["audioUrl", "mediaUrl", "voiceUrl", "user_voice"]);
}

async function enqueueEsp32Event(input: QueueEventInput): Promise<string> {
    const eventRef = db.collection(ESP32_QUEUE_COLLECTION).doc();

    await db.runTransaction(async (transaction) => {
        const stateSnapshot = await transaction.get(ESP32_QUEUE_STATE_DOC);
        const lastSequence = stateSnapshot.data()?.lastSequence;
        const nextSequence = typeof lastSequence === "number" ? lastSequence + 1 : 1;

        const eventDoc: Record<string, unknown> = {
            eventType: input.eventType,
            payload: input.payload,
            sequence: nextSequence,
            status: "pending",
            createdAt: FieldValue.serverTimestamp(),
        };

        if (input.userId) {
            eventDoc.userId = input.userId;
        }
        if (typeof input.handNumber === "number") {
            eventDoc.handNumber = input.handNumber;
        }
        if (input.sourceCollection) {
            eventDoc.sourceCollection = input.sourceCollection;
        }
        if (input.sourceId) {
            eventDoc.sourceId = input.sourceId;
        }

        transaction.set(ESP32_QUEUE_STATE_DOC, {
            lastSequence: nextSequence,
            updatedAt: FieldValue.serverTimestamp(),
        }, {merge: true});

        transaction.set(eventRef, eventDoc);
    });

    logger.log(`Queued ESP32 event '${input.eventType}' as ${eventRef.id}`);
    return eventRef.id;
}

async function findUserByMessageData(messageData: Record<string, unknown>) {
    const targetUserId = readStringField(messageData, ["targetUserId", "recipientId", "userId"]);
    if (targetUserId && targetUserId !== "all") {
        const userSnapshot = await db.collection("users").doc(targetUserId).get();
        if (userSnapshot.exists) {
            return {id: userSnapshot.id, data: userSnapshot.data() as Record<string, unknown>};
        }
    }

    const targetUserName = readStringField(messageData, ["targetUserName", "recipientName", "fullName"]);
    if (targetUserName) {
        const usersSnapshot = await db.collection("users")
            .where("fullName", "==", targetUserName)
            .limit(1)
            .get();
        if (!usersSnapshot.empty) {
            const userDoc = usersSnapshot.docs[0];
            return {id: userDoc.id, data: userDoc.data() as Record<string, unknown>};
        }
    }

    return null;
}

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
                    const existingHand = docData?.handNumber;
                    if (
                        doc.id !== userId &&
                        typeof existingHand === "number" &&
                        existingHand >= 0 &&
                        existingHand <= 3
                    ) {
                        takenHands.add(existingHand);
          }
        });

                // Find the first available physical clock hand number in [0, 1, 2, 3]
        let assignedHand: number | null = null;
                for (const hand of [0, 1, 2, 3]) {
                    if (!takenHands.has(hand)) {
                        assignedHand = hand;
            break;
          }
        }

        // Handle edge cases and allocate using set and merge (including protected name and location)
        if (assignedHand === null) {
          logger.log(`No hand for ${finalName} (${userId}). Waiting list.`);
          transaction.set(snapshot.ref, {
            fullName: finalName, 
            currentLocation: finalLocation, // Updates to the safe/corrected location
                        handNumber: null,
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
 * Trigger: Fires when a new location document is created.
 * Purpose: Automatically assigns the first free angle from [0, 90, 180, 270].
 */
export const onLocationCreated = onDocumentCreated("locations/{locationId}",
    async (event) => {
        const snapshot = event.data;
        if (!snapshot) {
            logger.log("No data associated with this event");
            return;
        }

        const locationId = event.params.locationId;

        try {
            await db.runTransaction(async (transaction) => {
                const locationsSnapshot = await transaction.get(db.collection("locations"));
                const takenAngles = new Set<number>();

                locationsSnapshot.forEach((doc) => {
                    const docData = doc.data();
                    const existingAngle = docData?.angle;

                    if (
                        doc.id !== locationId &&
                        typeof existingAngle === "number" &&
                        [0, 90, 180, 270].includes(existingAngle)
                    ) {
                        takenAngles.add(existingAngle);
                    }
                });

                let assignedAngle: number | null = null;
                for (const angle of [0, 90, 180, 270]) {
                    if (!takenAngles.has(angle)) {
                        assignedAngle = angle;
                        break;
                    }
                }

                if (assignedAngle === null) {
                    logger.warn(`No free angle slot for location ${locationId}. Setting angle to null.`);
                } else {
                    logger.log(`Assigning angle ${assignedAngle} to location ${locationId}`);
                }

                transaction.set(snapshot.ref, {
                    angle: assignedAngle,
                }, { merge: true });
            });
        } catch (error) {
            logger.error("Failed to auto-assign location angle:", error);
        }
    }
);



/**
 * Trigger: Fires when an existing user document is updated.
 * Purpose 1: Detects location changes, fetches the matching physical clock angle, and updates targetAngle.
 * Purpose 2: Trigger Queued Messages - Checks if the user arrived "HOME" and releases relevant pending messages.
 * NEW: Validates location against allowed locations and reverts to "Unknown Location" if invalid.
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

    // If the new location is empty, missing, or already "Unknown Location", handle gracefully and exit
    if (!afterLocation || afterLocation === "Unknown Location") {
        logger.log("Location is empty or Unknown. Setting targetAngle to default (0).");
        await change.after.ref.set({ targetAngle: 0, currentLocation: "Unknown Location" }, { merge: true });
        return;
    }

    try {
        // --- PART 1: Validate Location and Update targetAngle ---
        const locationsRef = db.collection("locations");
        const snapshot = await locationsRef.where("locationName", "==", afterLocation).limit(1).get();

        let targetAngle = 0; 
        let finalLocation = afterLocation; // Assume valid until proven otherwise
        let locationDataForQueue: Record<string, unknown> | null = null;

        if (snapshot.empty) {
            // FIX: If location is not in the list, force it to 'Unknown Location'
            logger.warn(`Location '${afterLocation}' not found in locations collection. Reverting to 'Unknown Location'.`);
            finalLocation = "Unknown Location"; 
        } else {
            const locationDoc = snapshot.docs[0].data() as Record<string, unknown>;
            locationDataForQueue = locationDoc;
            const locationAngle = readNumericField(locationDoc, ["angle"]);
            if (locationAngle !== null) {
                targetAngle = locationAngle;
                logger.log(`Found location '${afterLocation}' with angle ${targetAngle}`);
            } else {
                logger.warn(`Location '${afterLocation}' found but is missing 'angle'. Using 0.`);
            }
        }

        // Update both the angle AND the validated location (overwrites invalid locations)
        await change.after.ref.set({ 
            targetAngle: targetAngle,
            currentLocation: finalLocation 
        }, { merge: true });

        logger.log(`Successfully updated user ${event.params.userId} - Location: '${finalLocation}', Angle: ${targetAngle}`);

        const afterDataMap = afterData as Record<string, unknown>;
        const userId = event.params.userId;
        const handNumber = readNumericField(afterDataMap, ["handNumber"]);
        const fallbackScreen = handNumber !== null ? handNumber : undefined;

        if (finalLocation !== "Unknown Location" && locationDataForQueue) {
            const screen = readLocationScreen(locationDataForQueue) ?? fallbackScreen;
            const locationSoundUrl = readLocationSoundUrl(locationDataForQueue);
            const userVoiceUrl = readAudioUrl(afterDataMap);

            if (locationSoundUrl && userVoiceUrl) {
                await enqueueEsp32Event({
                    eventType: "play_voice",
                    userId,
                    handNumber: handNumber === null ? undefined : handNumber,
                    payload: {
                        screen,
                        audioUrl: locationSoundUrl,
                        source: "location_sound",
                        locationName: finalLocation,
                    },
                    sourceCollection: "users",
                    sourceId: userId,
                });

                await enqueueEsp32Event({
                    eventType: "play_voice",
                    userId,
                    handNumber: handNumber === null ? undefined : handNumber,
                    payload: {
                        screen,
                        audioUrl: userVoiceUrl,
                        source: "user_voice",
                        locationName: finalLocation,
                    },
                    sourceCollection: "users",
                    sourceId: userId,
                });
            }

            await enqueueEsp32Event({
                eventType: "move_clock_hand",
                userId,
                handNumber: handNumber === null ? undefined : handNumber,
                payload: {
                    handNumber,
                    angle: targetAngle,
                    locationName: finalLocation,
                },
                sourceCollection: "users",
                sourceId: userId,
            });

            await enqueueEsp32Event({
                eventType: "update_display",
                userId,
                handNumber: handNumber === null ? undefined : handNumber,
                payload: {
                    screen,
                    pictureUrl: readPictureUrl(afterDataMap),
                    text: finalLocation,
                },
                sourceCollection: "users",
                sourceId: userId,
            });
        }

        // --- PART 2: Trigger Queued Messages On Arrival ---
        // Only trigger if they successfully arrived HOME
        if (finalLocation === "HOME") {
            const userName = afterData?.fullName;
            logger.log(`User '${userName}' arrived HOME. Checking for queued messages...`);

            const queuedMessagesSnapshot = await db.collection("voice_messages")
                .where("status", "==", "queued")
                .get();

            if (!queuedMessagesSnapshot.empty) {
                const batch = db.batch();
                let messagesUpdatedCount = 0;

                queuedMessagesSnapshot.docs.forEach((msgDoc) => {
                    const msgData = msgDoc.data();
                    const targetName = msgData.targetUserName || msgData.recipientName;

                    if (!targetName || targetName === userName) {
                        logger.log(`Queue match found! Preparing to play message ${msgDoc.id} for ${userName || 'the family'}.`);
                        batch.update(msgDoc.ref, { status: "ready_to_play" });
                        messagesUpdatedCount++;
                    }
                });

                if (messagesUpdatedCount > 0) {
                    await batch.commit();
                    logger.log(`Successfully triggered ${messagesUpdatedCount} queued messages for playback.`);
                } else {
                    logger.log("Queued messages exist, but none are for the user who just arrived.");
                }
            } else {
                logger.log("No queued messages found in the database. The house is clear.");
            }
        }

    } catch (error) {
        logger.error("Error executing onUserLocationChanged:", error);
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
        const bucket = getStorage().bucket();
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
    const deletedLocationData = snapshot.data() as Record<string, unknown>;
    const deletedLocationName = deletedLocationData?.locationName; 
    const deletedLocationScreen = readLocationScreen(deletedLocationData);

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

                const enqueuePromises: Promise<string>[] = [];

                usersSnapshot.docs.forEach((doc) => {
            logger.log(`Preparing location reset for user ID: ${doc.id}`);
                        const userData = doc.data() as Record<string, unknown>;
                        const handNumber = readNumericField(userData, ["handNumber"]);
            
            // Update the user fields to default values as specified in User Story 3
            batch.update(doc.ref, {
                currentLocation: "Unknown Location", // Set status to unknown since the location no longer exists
                targetAngle: 0                       // Reset motor target angle to 0 (hand pointing straight up)
            });

                        enqueuePromises.push(
                            enqueueEsp32Event({
                                eventType: "reset_screen",
                                userId: doc.id,
                                handNumber: handNumber === null ? undefined : handNumber,
                                payload: {
                                    screen: deletedLocationScreen ?? handNumber,
                                    locationName: deletedLocationName,
                                },
                                sourceCollection: "locations",
                                sourceId: event.params.locationId,
                            })
                        );
        });

        // 3. Commit the batch write operation to Firestore
        await batch.commit();
                await Promise.all(enqueuePromises);
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

    const messageData = snapshot.data() as Record<string, unknown>;
    
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

        const targetUser = await findUserByMessageData(messageData);
        const handNumber = targetUser ? readNumericField(targetUser.data, ["handNumber"]) : null;
        const audioUrl = readAudioUrl(messageData);

        if (audioUrl) {
            await enqueueEsp32Event({
                eventType: "play_voice",
                userId: targetUser ? targetUser.id : undefined,
                handNumber: handNumber === null ? undefined : handNumber,
                payload: {
                    audioUrl,
                    messageId: event.params.messageId,
                    targetUserId: targetUser ? targetUser.id : null,
                    shouldPlayImmediately,
                },
                sourceCollection: "voice_messages",
                sourceId: event.params.messageId,
            });
        }
        
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
async function processVisualGreeting(
    greetingId: string,
    sourceCollection: string,
    greetingData: Record<string, unknown>
) {
        const targetUserId = readStringField(greetingData, ["targetUserId"]);
        const targetUserName = readStringField(greetingData, ["targetUserName", "recipientName"]);
        const imageUrl = readPictureUrl(greetingData);

        if (!imageUrl || (!targetUserId && !targetUserName)) {
            logger.warn(`Visual greeting ${greetingId} missing target or image URL. Aborting execution.`);
            return;
        }

        let userDocId: string | null = null;
        let userData: Record<string, unknown> | null = null;

        if (targetUserId) {
            const userSnapshot = await db.collection("users").doc(targetUserId).get();
            if (userSnapshot.exists) {
                userDocId = userSnapshot.id;
                userData = userSnapshot.data() as Record<string, unknown>;
            }
        }

        if (!userDocId && targetUserName) {
            const usersSnapshot = await db.collection("users")
                .where("fullName", "==", targetUserName)
                .limit(1)
                .get();

            if (!usersSnapshot.empty) {
                userDocId = usersSnapshot.docs[0].id;
                userData = usersSnapshot.docs[0].data() as Record<string, unknown>;
            }
        }

        if (!userDocId || !userData) {
            logger.warn(`Target user for visual greeting ${greetingId} not found.`);
            return;
        }

        const currentLocation = readStringField(userData, ["currentLocation"]);
        const handNumber = readNumericField(userData, ["handNumber"]);
        let screen: string | number | null = handNumber;

        if (currentLocation && currentLocation !== "Unknown Location") {
            const locationSnapshot = await db.collection("locations")
                .where("locationName", "==", currentLocation)
                .limit(1)
                .get();
            if (!locationSnapshot.empty) {
                const locationData = locationSnapshot.docs[0].data() as Record<string, unknown>;
                const locationScreen = readLocationScreen(locationData);
                if (locationScreen !== null) {
                    screen = locationScreen;
                }
            }
        }

        await db.collection("users").doc(userDocId).set({
            displayGreetingUrl: imageUrl,
        }, {merge: true});

        await enqueueEsp32Event({
            eventType: "play_picture",
            userId: userDocId,
            handNumber: handNumber === null ? undefined : handNumber,
            payload: {
                screen,
                pictureUrl: imageUrl,
                locationName: currentLocation ?? "Unknown Location",
            },
            sourceCollection,
            sourceId: greetingId,
        });

        logger.log(`Queued play_picture event for user '${userDocId}' from ${sourceCollection}/${greetingId}.`);
}

export const onVisualGreetingCreated = onDocumentCreated("visual_greetings/{greetingId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
        logger.error("No data associated with the new visual greeting event");
        return;
    }

        try {
            await processVisualGreeting(
                event.params.greetingId,
                "visual_greetings",
                snapshot.data() as Record<string, unknown>
            );
        } catch (error) {
            logger.error("Error processing visual greeting:", error);
        }
});

export const onVisualMessageCreated = onDocumentCreated("visual_messages/{messageId}", async (event) => {
        const snapshot = event.data;
        if (!snapshot) {
            logger.error("No data associated with the new visual message event");
            return;
        }

        try {
            await processVisualGreeting(
                event.params.messageId,
                "visual_messages",
                snapshot.data() as Record<string, unknown>
            );
        } catch (error) {
            logger.error("Error processing visual message:", error);
        }
});

/**
 * Scheduled Function: checkAndPromptMissingUpdates
 * Triggers automatically twice a day (e.g., 08:00 and 16:00 Israel time).
 * Purpose: Scans for users with "Unknown Location" or stale updates and sends them a push notification.
 */
export const checkAndPromptMissingUpdates = onSchedule(
    {
        schedule: "0 8,16 * * *", // Cron syntax: Runs at minute 0 past hour 8 and 16 daily
        timeZone: "Asia/Jerusalem" // Configured for Israel timezone
    },
    async (event) => {
        logger.log("Starting scheduled check for missing location updates...");

        try {
            const usersSnapshot = await db.collection("users").get();
            
            if (usersSnapshot.empty) {
                logger.log("No users found in database. Exiting.");
                return;
            }

            // Define the threshold for a "stale" update (e.g., 8 hours in milliseconds)
            const STALE_THRESHOLD_MS = 8 * 60 * 60 * 1000;
            const nowMs = Date.now();
            
            // Array to hold all push notification promises so we can send them concurrently
            const notificationsToPromise: Promise<string>[] = [];
            let alertCount = 0;

            usersSnapshot.forEach((doc) => {
                const userData = doc.data();
                const userName = userData.fullName || "User";
                const currentLocation = userData.currentLocation || "Unknown Location";
                
                // CRITICAL FIELDS EXPECTED FROM FLUTTER APP:
                const fcmToken = userData.fcmToken; // The Firebase Cloud Messaging token for the device
                const lastUpdatedTimestamp = userData.lastLocationUpdateTime; // A Firestore Timestamp object
                
                let needsAlert = false;

                // Condition 1: Location is explicitly unknown
                if (currentLocation === "Unknown Location" || currentLocation === "Unknown") {
                    needsAlert = true;
                    logger.log(`User '${userName}' has an unknown location.`);
                } 
                // Condition 2: Location is known but hasn't been updated in X hours
                else if (lastUpdatedTimestamp) {
                    const lastUpdatedMs = lastUpdatedTimestamp.toDate().getTime();
                    if ((nowMs - lastUpdatedMs) > STALE_THRESHOLD_MS) {
                        needsAlert = true;
                        logger.log(`User '${userName}' hasn't updated location in over 8 hours.`);
                    }
                }

                // If conditions are met AND we have a device token to send the message to
                if (needsAlert && fcmToken) {
                    const message = {
                        notification: {
                            title: "המשפחה מחכה לדעת איפה את/ה! 🕒",
                            body: `היי ${userName}, אל תשכח/י לעדכן את המיקום שלך בשעון.`
                        },
                        token: fcmToken
                    };

                    // Queue the push notification sending process
                    notificationsToPromise.push(getMessaging().send(message));
                    alertCount++;
                } else if (needsAlert && !fcmToken) {
                    logger.warn(`User '${userName}' needs an alert but has no 'fcmToken' registered in their document.`);
                }
            });

            // Execute all pending push notifications to the Flutter apps at once
            if (notificationsToPromise.length > 0) {
                await Promise.all(notificationsToPromise);
                logger.log(`Successfully sent ${alertCount} reminder push notifications.`);
            } else {
                logger.log("No users required location reminders at this time.");
            }

        } catch (error) {
            logger.error("Error executing scheduled location checks:", error);
        }
    }
);

/**
 * Scheduled Function: flagStaleLocations
 * Triggers automatically every hour at minute 0.
 * Purpose: Scans for users who haven't updated their location in over 12 hours.
 * If a location is stale, it automatically reverts the user to "Unknown Location" 
 * and resets their physical clock hand to angle 0.
 */
export const flagStaleLocations = onSchedule(
    {
        schedule: "0 * * * *", // Cron syntax: Runs every hour exactly at the top of the hour
        timeZone: "Asia/Jerusalem" // Configured for Israel timezone
    },
    async (event) => {
        logger.log("Starting hourly check for stale locations...");

        try {
            const usersSnapshot = await db.collection("users").get();
            
            if (usersSnapshot.empty) {
                logger.log("No users found in database. Exiting.");
                return;
            }

            // Define the threshold for a "stale" update (12 hours in milliseconds)
            const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;
            const nowMs = Date.now();
            
            // Use a batch write to efficiently update multiple users at once
            const batch = db.batch();
            let staleCount = 0;

            usersSnapshot.forEach((doc) => {
                const userData = doc.data();
                const userName = userData.fullName || "Unknown User";
                const currentLocation = userData.currentLocation;
                const lastUpdatedTimestamp = userData.lastLocationUpdateTime;

                // If the user is already at an Unknown Location, skip them to save operations
                if (!currentLocation || currentLocation === "Unknown Location") {
                    return; 
                }

                // Check if the timestamp exists and calculate the difference
                if (lastUpdatedTimestamp) {
                    const lastUpdatedMs = lastUpdatedTimestamp.toDate().getTime();
                    const timeDifference = nowMs - lastUpdatedMs;

                    if (timeDifference > STALE_THRESHOLD_MS) {
                        logger.log(`User '${userName}' has a stale location (Over 12 hours). Reverting to Unknown Location.`);
                        
                        // Add the update operation to the batch
                        batch.update(doc.ref, {
                            currentLocation: "Unknown Location",
                            targetAngle: 0
                        });
                        staleCount++;
                    }
                } else {
                    // Edge Case: If the user has a location but NO timestamp was ever recorded, 
                    // we flag them as stale for safety.
                    logger.warn(`User '${userName}' has a set location but no 'lastLocationUpdateTime'. Reverting to Unknown Location.`);
                    batch.update(doc.ref, {
                        currentLocation: "Unknown Location",
                        targetAngle: 0
                    });
                    staleCount++;
                }
            });

            // Commit the batch to the database if we found any stale users
            if (staleCount > 0) {
                await batch.commit();
                logger.log(`Successfully reset ${staleCount} stale user(s) to Unknown Location.`);
            } else {
                logger.log("All user locations are up to date. No stale locations found.");
            }

        } catch (error) {
            logger.error("Error executing scheduled stale locations check:", error);
        }
    }
);

/**
 * Scheduled Function: cleanupExpiredVoiceMessages
 * Triggers automatically every day at 02:00 AM Israel time.
 * Purpose: Cleans up old voice messages from Firestore and their associated audio files from Cloud Storage.
 * Logic: 
 * - Played/Listened messages: deleted after 48 hours.
 * - Queued messages: deleted after 7 days (to prevent losing messages if a user is away).
 */
export const cleanupExpiredVoiceMessages = onSchedule(
    {
        schedule: "0 2 * * *", // Runs every day at 02:00 AM
        timeZone: "Asia/Jerusalem" 
    },
    async (event) => {
        logger.log("Starting daily cleanup of expired voice messages...");

        try {
            const nowMs = Date.now();
            const PLAYED_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
            const QUEUED_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

            // Optimization: We query only messages created before (Now - 48 hours). 
            // This prevents the function from reading fresh messages and saves database reads.
            const cutoffDate48h = new Date(nowMs - PLAYED_THRESHOLD_MS);
            
            const messagesSnapshot = await db.collection("voice_messages")
                .where("timestamp", "<=", cutoffDate48h)
                .get();

            if (messagesSnapshot.empty) {
                logger.log("No messages older than 48 hours found. Cleanup complete.");
                return;
            }

            const batch = db.batch();
            const bucket = getStorage().bucket();
            let deletedCount = 0;

            // Use a standard 'for...of' loop because we are doing asynchronous Storage deletions inside
            for (const doc of messagesSnapshot.docs) {
                const msgData = doc.data();
                const status = msgData.status || "queued";
                
                // Extract timestamp safely. Defaults to 0 if missing.
                const msgTimestamp = msgData.timestamp?.toDate()?.getTime() || 0;
                const audioUrl = msgData.audioUrl;
                
                let shouldDelete = false;

                // Condition 1: Played/Listened (or stuck in ready_to_play) older than 48 hours
                if ((status === "played" || status === "listened" || status === "ready_to_play") && 
                    (nowMs - msgTimestamp > PLAYED_THRESHOLD_MS)) {
                    shouldDelete = true;
                    logger.log(`Flagging PLAYED message ${doc.id} for deletion (over 48 hours).`);
                } 
                // Condition 2: Queued messages older than 7 days
                else if (status === "queued" && (nowMs - msgTimestamp > QUEUED_THRESHOLD_MS)) {
                    shouldDelete = true;
                    logger.log(`Flagging QUEUED message ${doc.id} for deletion (expired after 7 days).`);
                }

                if (shouldDelete) {
                    // --- Step 1: Delete physical audio file from Cloud Storage ---
                    if (audioUrl) {
                        try {
                            // Parse the Firebase Storage Download URL to extract the exact file path
                            let filePath = "";
                            if (audioUrl.includes("/o/")) {
                                // Extract the string between '/o/' and '?' and decode URL characters (like %2F to '/')
                                filePath = decodeURIComponent(audioUrl.split("/o/")[1].split("?")[0]);
                            }
                            
                            if (filePath) {
                                await bucket.file(filePath).delete();
                                logger.log(`Successfully deleted audio file from Storage: ${filePath}`);
                            } else {
                                logger.warn(`Could not extract valid file path from audioUrl for message ${doc.id}`);
                            }
                        } catch (storageErr: any) {
                            // If file doesn't exist (e.g., deleted manually), catch error code 404 and ignore,
                            // otherwise log the warning. Do not break the loop.
                            if (storageErr.code !== 404) {
                                logger.warn(`Failed to delete Storage file for message ${doc.id}:`, storageErr);
                            }
                        }
                    }

                    // --- Step 2: Queue the Firestore document for deletion ---
                    batch.delete(doc.ref);
                    deletedCount++;
                }
            }

            // Commit all document deletions to Firestore simultaneously
            if (deletedCount > 0) {
                await batch.commit();
                logger.log(`Successfully deleted ${deletedCount} expired voice messages from database.`);
            } else {
                logger.log("Messages found, but none met the expiration conditions for their specific status.");
            }

        } catch (error) {
            logger.error("Error executing cleanupExpiredVoiceMessages:", error);
        }
    }
);

/**
 * Scheduled Function: clearVisualGreetings
 * Triggers automatically every day at midnight (00:00 Israel time).
 * Purpose 1: Resets the 'displayGreetingUrl' for all users to clear daily doodles from the LCDs.
 * Purpose 2: Deletes old doodle documents from Firestore and their image files from Cloud Storage.
 */
export const clearVisualGreetings = onSchedule(
    {
        schedule: "0 0 * * *", // Cron syntax: Runs at 00:00 (midnight) every day
        timeZone: "Asia/Jerusalem" // Configured for Israel timezone
    },
    async (event) => {
        logger.log("Starting midnight cleanup of visual greetings...");

        try {
            const batch = db.batch();
            let userResetCount = 0;
            let greetingDeleteCount = 0;

            // --- PART 1: Clear LCD screens for all users ---
            const usersSnapshot = await db.collection("users").get();
            
            if (!usersSnapshot.empty) {
                usersSnapshot.forEach((doc) => {
                    const userData = doc.data();
                    // Reset the URL only if one exists
                    if (userData.displayGreetingUrl && userData.displayGreetingUrl !== "") {
                        batch.update(doc.ref, { displayGreetingUrl: "" });
                        userResetCount++;
                    }
                });
            }

            // --- PART 2: Delete expired visual greetings from Firestore and Storage ---
            const greetingsSnapshot = await db.collection("visual_greetings").get();
            const bucket = getStorage().bucket();

            if (!greetingsSnapshot.empty) {
                // Loop to handle asynchronous Storage deletions
                for (const doc of greetingsSnapshot.docs) {
                    const greetingData = doc.data();
                    const imageUrl = greetingData.imageUrl || greetingData.greetingUrl;

                    // Delete the physical image file from Cloud Storage
                    if (imageUrl) {
                        try {
                            let filePath = "";
                            if (imageUrl.includes("/o/")) {
                                filePath = decodeURIComponent(imageUrl.split("/o/")[1].split("?")[0]);
                            }
                            
                            if (filePath) {
                                await bucket.file(filePath).delete();
                                logger.log(`Deleted doodle image from Storage: ${filePath}`);
                            }
                        } catch (storageErr: any) {
                            if (storageErr.code !== 404) {
                                logger.warn(`Failed to delete Storage file for doodle ${doc.id}:`, storageErr);
                            }
                        }
                    }

                    // Queue the Firestore document for deletion
                    batch.delete(doc.ref);
                    greetingDeleteCount++;
                }
            }

            // --- Commit all updates and deletions together ---
            if (userResetCount > 0 || greetingDeleteCount > 0) {
                await batch.commit();
                logger.log(`Successfully cleared ${userResetCount} user screens and deleted ${greetingDeleteCount} old doodles.`);
            } else {
                logger.log("No active visual greetings found. Everything is already clean.");
            }

        } catch (error) {
            logger.error("Error executing midnight visual greetings cleanup:", error);
        }
    }
);

/**
 * HTTP Callable Function: sendDirectLocationPrompt
 * Trigger: Flutter app calls this endpoint when User A wants User B to update their location.
 * Purpose: Sends a push notification to User B, protected by Auth and a 7-minute cooldown.
 */
export const sendDirectLocationPrompt = onCall(async (request) => {
    // --- 1. Security Check: Verify user is authenticated ---
    // The 'onCall' wrapper automatically verifies the Firebase Auth token.
    if (!request.auth) {
        throw new HttpsError(
            "unauthenticated", 
            "You must be logged in to send a location prompt."
        );
    }

    const senderId = request.auth.uid; // The ID of the person pushing the button
    const targetUserId = request.data.targetUserId; // The ID of the person they want to prompt

    if (!targetUserId) {
        throw new HttpsError(
            "invalid-argument", 
            "The function must be called with a 'targetUserId'."
        );
    }

    try {
        // --- 2. Fetch Sender and Target User Data concurrently ---
        const targetUserRef = db.collection("users").doc(targetUserId);
        
        const [senderDoc, targetUserDoc] = await Promise.all([
            db.collection("users").doc(senderId).get(),
            targetUserRef.get()
        ]);

        if (!targetUserDoc.exists) {
            throw new HttpsError("not-found", "Target user not found.");
        }

        const targetData = targetUserDoc.data();
        const senderName = senderDoc.exists ? senderDoc.data()?.fullName : "A family member";
        
        // --- 3. Rate Limiting (7-minute cooldown anti-spam) ---
        const lastPromptedTime = targetData?.lastPromptedTime;
        const nowMs = Date.now();
        const COOLDOWN_MS = 7 * 60 * 1000; // 7 minutes in milliseconds

        if (lastPromptedTime) {
            // Convert Firestore Timestamp to milliseconds
            const lastPromptedMs = lastPromptedTime.toDate().getTime();
            if (nowMs - lastPromptedMs < COOLDOWN_MS) {
                // Calculate remaining minutes for a helpful error message to the Flutter UI
                const remainingMins = Math.ceil((COOLDOWN_MS - (nowMs - lastPromptedMs)) / 60000);
                throw new HttpsError(
                    "resource-exhausted", 
                    `Please wait ${remainingMins} minutes before prompting this user again.`
                );
            }
        }

        // --- 4. Verify Target has an FCM Token ---
        const fcmToken = targetData?.fcmToken;
        if (!fcmToken) {
            throw new HttpsError(
                "failed-precondition", 
                "Target user does not have a registered device token for notifications."
            );
        }

        // --- 5. Send the Push Notification via FCM ---
        const message = {
            notification: {
                title: "איפה את/ה? 📍",
                body: `${senderName} מחכה שתעדכן/י מיקום בשעון המשפחתי!`
            },
            token: fcmToken
        };

        await getMessaging().send(message);
        logger.log(`Prompt sent successfully from '${senderName}' to user ID: '${targetUserId}'`);

        // --- 6. Update the Cooldown Timestamp ---
        // We use serverTimestamp() to ensure time accuracy across different devices
        await targetUserRef.update({
            lastPromptedTime: FieldValue.serverTimestamp()
        });

        // --- 7. Return Success Response to Flutter ---
        return {
            status: "success",
            message: "Location prompt sent successfully."
        };

    } catch (error: any) {
        logger.error("Error in sendDirectLocationPrompt:", error);
        
        // If it's already an HttpsError (like our cooldown restriction), throw it directly to the client
        if (error instanceof HttpsError) {
            throw error;
        }
        // Otherwise, wrap unexpected internal errors
        throw new HttpsError("internal", "An internal error occurred while sending the prompt.");
    }
});

/**
 * HTTP Request Function: getClockInitConfig
 * Trigger: ESP32 hardware calls this standard HTTP GET endpoint on startup or reset.
 * Purpose: Fetches all active locations and their corresponding angles.
 * Returns: A lightweight JSON object optimized for C++ ArduinoJson parsing.
 */
export const getClockInitConfig = onRequest(async (request, response) => {
    // --- 1. Restrict to GET requests only ---
    // Hardware should only read data, not modify it via this endpoint.
    if (request.method !== "GET") {
        response.status(405).json({ error: "Method Not Allowed. Please use GET." });
        return;
    }

    try {
        logger.log("ESP32 hardware requested clock initialization config.");

        // --- 2. Fetch all locations from Firestore ---
        const locationsSnapshot = await db.collection("locations").get();
        
        // We will build an array of location objects. 
        // This array structure is very easy to parse using ArduinoJson on the ESP32.
        const locationsArray: any[] = [];

        locationsSnapshot.forEach((doc) => {
            const data = doc.data();
            
            // Validate that the document actually has the required fields
            if (data.locationName && data.angle !== undefined) {
                locationsArray.push({
                    name: data.locationName,
                    angle: data.angle
                });
            } else {
                logger.warn(`Skipped invalid location document: ${doc.id}`);
            }
        });

        // --- 3. Return the JSON payload to the hardware ---
        // Setting a 200 OK status and sending the structured data
        response.status(200).json({
            status: "success",
            total_locations: locationsArray.length,
            locations: locationsArray
        });

        logger.log(`Successfully returned ${locationsArray.length} locations to the ESP32.`);

    } catch (error) {
        logger.error("Error fetching hardware init config:", error);
        // Send a 500 Internal Server Error if something crashes
        response.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * HTTP Request Function: reportHardwareStatus
 * Trigger: ESP32 hardware sends an HTTP POST request when it encounters an error or status change.
 * Purpose: Logs the issue to the 'system_status' document in Firestore.
 * If the error is critical, it attempts to send a Push Notification to the system Admin.
 */
export const reportHardwareStatus = onRequest(async (request, response) => {
    // --- 1. Restrict to POST requests only ---
    // The hardware must send a POST request containing the error data in the body.
    if (request.method !== "POST") {
        response.status(405).json({ error: "Method Not Allowed. Please use POST." });
        return;
    }

    try {
        // Extract data from the incoming JSON body sent by the ESP32
        const { errorCode, errorMessage, severity, timestamp } = request.body;

        if (!errorCode || !severity) {
            logger.warn("Received malformed hardware status report:", request.body);
            response.status(400).json({ error: "Bad Request. Missing errorCode or severity." });
            return;
        }

        logger.log(`Received hardware report: Code [${errorCode}], Severity [${severity}]`);

        // --- 2. Update the System Status Document in Firestore ---
        // We maintain a single document 'clock_health' inside a 'system_status' collection
        const systemStatusRef = db.collection("system_status").doc("clock_health");
        
        await systemStatusRef.set({
            lastReportTime: FieldValue.serverTimestamp(),
            hardwareTimestamp: timestamp || Date.now(),
            currentErrorCode: errorCode,
            currentErrorMessage: errorMessage || "No detailed message provided.",
            severityLevel: severity,
            status: severity === "critical" || severity === "error" ? "needs_attention" : "operational"
        }, { merge: true });

        logger.log("Successfully updated system_status document in Firestore.");

        // --- 3. Alert the Admin if the severity is CRITICAL ---
        if (severity === "critical") {
            logger.log("Critical error detected. Attempting to alert the Admin...");
            
            // Query for the admin user to get their FCM token
            const adminSnapshot = await db.collection("users")
                .where("role", "==", "admin")
                .limit(1)
                .get();

            if (!adminSnapshot.empty) {
                const adminDoc = adminSnapshot.docs[0].data();
                const fcmToken = adminDoc.fcmToken;

                if (fcmToken) {
                    const message = {
                        notification: {
                            title: "⚠️ התראת חומרה: שעון המשפחה",
                            body: `זוהתה תקלה קריטית: ${errorMessage || errorCode}. נא לבדוק את השעון.`
                        },
                        token: fcmToken
                    };

                    await getMessaging().send(message);
                    logger.log("Critical Push Notification sent to Admin.");
                } else {
                    logger.warn("Admin user found, but no FCM token is registered to send the alert.");
                }
            } else {
                logger.warn("No user with role 'admin' found in the database. Cannot send Push Notification.");
            }
        }

        // --- 4. Acknowledge Receipt to the Hardware ---
        response.status(200).json({
            status: "success",
            message: "Report logged successfully."
        });

    } catch (error) {
        logger.error("Error processing hardware status report:", error);
        response.status(500).json({ error: "Internal Server Error" });
    }
});

/**
 * HTTP Request Function: popNextEsp32Event
 * Trigger: ESP32 calls this endpoint to claim the next queue event in order.
 * Purpose: Pops one event at a time by sequence and marks it as processing.
 */
export const popNextEsp32Event = onRequest(async (request, response) => {
    if (request.method !== "GET") {
        response.status(405).json({error: "Method Not Allowed. Please use GET."});
        return;
    }

    try {
        const userId = typeof request.query.userId === "string" ? request.query.userId : null;
        let query = db.collection(ESP32_QUEUE_COLLECTION)
            .where("status", "==", "pending")
            .orderBy("sequence", "asc")
            .limit(1);

        if (userId) {
            query = query.where("userId", "==", userId);
        }

        const queueSnapshot = await query.get();
        if (queueSnapshot.empty) {
            response.status(200).json({status: "empty"});
            return;
        }

        const eventDoc = queueSnapshot.docs[0];
        await db.runTransaction(async (transaction) => {
            const latestSnapshot = await transaction.get(eventDoc.ref);
            const latestStatus = latestSnapshot.data()?.status;
            if (latestStatus !== "pending") {
                throw new Error("Event already claimed");
            }

            transaction.update(eventDoc.ref, {
                status: "processing",
                claimedAt: FieldValue.serverTimestamp(),
            });
        });

        const eventData = eventDoc.data();
        response.status(200).json({
            status: "ok",
            event: {
                id: eventDoc.id,
                ...eventData,
            },
        });
    } catch (error) {
        logger.error("Error while popping next ESP32 event:", error);
        response.status(500).json({error: "Internal Server Error"});
    }
});

/**
 * HTTP Request Function: completeEsp32Event
 * Trigger: ESP32 calls this endpoint after handling an event.
 * Purpose: Marks an event as done (or failed).
 */
export const completeEsp32Event = onRequest(async (request, response) => {
    if (request.method !== "POST") {
        response.status(405).json({error: "Method Not Allowed. Please use POST."});
        return;
    }

    try {
        const eventId = typeof request.body?.eventId === "string" ? request.body.eventId : null;
        const wasSuccessful = request.body?.success !== false;
        const errorMessage = typeof request.body?.errorMessage === "string" ? request.body.errorMessage : null;

        if (!eventId) {
            response.status(400).json({error: "Bad Request. Missing eventId."});
            return;
        }

        const eventRef = db.collection(ESP32_QUEUE_COLLECTION).doc(eventId);
        const eventSnapshot = await eventRef.get();
        if (!eventSnapshot.exists) {
            response.status(404).json({error: "Event not found."});
            return;
        }

        await eventRef.set({
            status: wasSuccessful ? "done" : "failed",
            completedAt: FieldValue.serverTimestamp(),
            lastError: errorMessage,
        }, {merge: true});

        response.status(200).json({status: "success"});
    } catch (error) {
        logger.error("Error while completing ESP32 event:", error);
        response.status(500).json({error: "Internal Server Error"});
    }
});