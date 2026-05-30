import {setGlobalOptions} from "firebase-functions";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger"; 



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
      const locationsSnapshot = await db.collection("allowed_locations").get();
      
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
 * Purpose: Detects location changes, fetches the matching physical clock angle, and updates targetAngle.
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
        //Query the "locations" collection to find the matching angle
        const locationsRef = db.collection("locations");
        
        
        const snapshot = await locationsRef.where("locationName", "==", afterLocation).get();

        let targetAngle = 0; // Default angle for unconfigured or missing locations

        if (snapshot.empty) {
            // Handle unconfigured locations (e.g., a random coffee shop not set on the clock)
            logger.warn(`Location '${afterLocation}' not found in locations collection. Using default angle 0.`);
            targetAngle = 0; 
        } else {
            // Location found! Extract the angle from the first matching document
            const locationDoc = snapshot.docs[0].data();
            if (locationDoc.angle !== undefined) {
                targetAngle = locationDoc.angle;
                logger.log(`Found location '${afterLocation}' with angle ${targetAngle}`);
            } else {
                logger.warn(`Location '${afterLocation}' found but is missing the 'angle' field. Using 0.`);
            }
        }

        // Update the user's document with the newly calculated targetAngle
        await change.after.ref.set({
            targetAngle: targetAngle
        }, { merge: true });

        logger.log(`Successfully updated targetAngle to ${targetAngle} for user ${event.params.userId}`);

    } catch (error) {
        logger.error("Error fetching location or updating user document:", error);
    }
});