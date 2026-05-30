import {setGlobalOptions} from "firebase-functions";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger"; 
admin.initializeApp();

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
    const db = admin.firestore();

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