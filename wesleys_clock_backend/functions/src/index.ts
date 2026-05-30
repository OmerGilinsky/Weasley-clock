import {setGlobalOptions} from "firebase-functions";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import { logger } from "firebase-functions"; 

admin.initializeApp();

setGlobalOptions({maxInstances: 10});

/**
 * טריגר: מתעורר ביצירת משתמש חדש
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

    // שליפת הנתונים הגולמיים ובדיקת תקינות השם בצורה בטוחה
    const userData = snapshot.data();
    let finalName = userData && userData.fullName ? userData.fullName : null;

    // הגנה: בדיקה שהשם הוא אכן מחרוזת ואינו ריק
    if (!finalName || typeof finalName !== "string" || finalName.trim() === "") {
      // הדפסת אזהרה כתומה ביומני הרישום של Firebase
      logger.warn(`[Validation Warning] Document created without a valid fullName. ID: ${userId}. Fallback to 'Unknown User'.`);
      finalName = "Unknown User";
    }

    // --- בדיקת מיקומים דינמית מול נתוני ה-GPS של האדמין ---
    let finalLocation = userData && userData.currentLocation ? userData.currentLocation : null;
    const allowedLocationNames: string[] = [];

    try {
      // שליפת כל מסמכי המיקומים וה-GPS שהאדמין הגדיר באוסף הייעודי
      const locationsSnapshot = await db.collection("allowed_locations").get();
      
      // מעבר על המיקומים ואסיפת שמות המיקומים החוקיים
      locationsSnapshot.forEach((doc) => {
        const locData = doc.data();
        if (locData && locData.locationName) {
          allowedLocationNames.push(locData.locationName);
        }
      });
    } catch (err) {
      logger.error("Failed to fetch allowed locations with GPS from DB", err);
    }

    // השוואה: אם המיקום שנתנה האפליקציה לא מופיע ברשימת האדמין - הופך ל-Unknown Location
    if (!finalLocation || !allowedLocationNames.includes(finalLocation)) {
      logger.warn(`[Location Warning] User ${finalName} provided location '${finalLocation}' which is not mapped with GPS. Fallback to 'Unknown Location'.`);
      finalLocation = "Unknown Location";
    }

    try {
      await db.runTransaction(async (transaction) => {
        // שליפת המשתמשים לבדיקת מחוגים
        const usersSnapshot = await transaction.get(db.collection("users"));

        const takenHands = new Set<number>();
        usersSnapshot.forEach((doc) => {
          // הגנה נוספת בזמן סריקת המשתמשים הקיימים מפני נתונים חסרים
          const docData = doc.data();
          if (doc.id !== userId && docData && docData.handNumber) {
            takenHands.add(docData.handNumber);
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

        // טיפול במקרה קצה והקצאה עם set ו-merge (כולל השם והמיקום המוגנים)
        if (assignedHand === null) {
          logger.log(`No hand for ${finalName} (${userId}). Waiting list.`);
          transaction.set(snapshot.ref, {
            fullName: finalName, 
            currentLocation: finalLocation, // מעדכן למיקום המתוקן
            handNumber: 0,
            status: "waiting_list",
          }, { merge: true });
        } else {
          logger.log(`Assigning hand ${assignedHand} to ${finalName}`);
          transaction.set(snapshot.ref, {
            fullName: finalName, 
            currentLocation: finalLocation, // מעדכן למיקום המתוקן
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