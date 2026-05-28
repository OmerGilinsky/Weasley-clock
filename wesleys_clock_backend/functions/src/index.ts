import {setGlobalOptions} from "firebase-functions";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";

admin.initializeApp();

setGlobalOptions({maxInstances: 10});

/**
 * טריגר: מתעורר ביצירת משתמש חדש
 */
export const onUserCreated = onDocumentCreated("users/{userId}",
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      console.log("No data associated with this event");
      return;
    }

    const userId = event.params.userId;
    const db = admin.firestore();

    try {
      await db.runTransaction(async (transaction) => {
        // שליפת המשתמשים לבדיקת מחוגים
        const usersSnapshot = await transaction.get(db.collection("users"));

        const takenHands = new Set<number>();
        usersSnapshot.forEach((doc) => {
          if (doc.id !== userId && doc.data().handNumber) {
            takenHands.add(doc.data().handNumber);
          }
        });

        // מציאת מספר המחוג הפנוי הראשון
        let assignedHand: number | null = null;
        for (let i = 1; i <= 4; i++) {
          if (!takenHands.has(i)) {
            assignedHand = i;
            break;
          }
        }

        // טיפול במקרה קצה והקצאה
        if (assignedHand === null) {
          console.log(`No hand for ${userId}. Waiting list.`);
          transaction.update(snapshot.ref, {
            handNumber: 0,
            status: "waiting_list",
          });
        } else {
          console.log(`Assigning hand ${assignedHand} to ${userId}`);
          transaction.update(snapshot.ref, {
            handNumber: assignedHand,
            status: "active",
          });
        }
      });

      console.log(`Transaction completed for user ${userId}`);
    } catch (error) {
      console.error("Transaction failed: ", error);
    }
  }
);