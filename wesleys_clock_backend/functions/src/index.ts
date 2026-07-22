import {setGlobalOptions} from "firebase-functions";
import { onDocumentCreated, onDocumentUpdated, onDocumentDeleted} from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger"; 
import {createHash, randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {writeFile, unlink, readFile as readFileBuffer} from "node:fs/promises";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";
import { getStorage } from "firebase-admin/storage";
import { getMessaging } from "firebase-admin/messaging";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onRequest } from "firebase-functions/v2/https";
import ffmpegPath from "ffmpeg-static";

const DATABASE_URL = "https://wesleys-clock-default-rtdb.firebaseio.com";

// Get the Firestore instance to share between functions
if (getApps().length === 0) {
    // initializeApp({databaseURL: DATABASE_URL});
    initializeApp({
        databaseURL: DATABASE_URL,
        storageBucket: "wesleys-clock.firebasestorage.app"
    });
}
const db = getFirestore();
const rtdb = getDatabase();

setGlobalOptions({maxInstances: 10});

const ESP32_QUEUE_COLLECTION = "esp32_event_queue";
const ESP32_QUEUE_STATE_DOC = db.collection("system_status").doc("esp32_queue_state");
const ESP32_QUEUE_STATE_RTDB_PATH = "system_status/esp32_queue_state";
const MEDIA_CONVERSIONS_COLLECTION = "media_conversions";
const execFileAsync = promisify(execFile);
const AUDIO_CONVERSION_PROFILE = "mp3_44100_stereo_128k_cbr_5s_v1";

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

type SanitizedQueueEvent = {
    payload: Record<string, unknown>;
    dropped: boolean;
    dropReason?: string;
};

function isMp3Url(url: string): boolean {
    const lower = url.toLowerCase();
    const pathLike = lower.split("?")[0].split("#")[0];
    return pathLike.endsWith(".mp3");
}

function toEsp32ImageUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) {
        return trimmed;
    }

    if (trimmed.includes("placehold.co/")) {
        return trimmed.replace(/\/\d+x\d+\//, "/280x240/");
    }

    if (trimmed.includes("images.weserv.nl")) {
        return trimmed;
    }

    const normalizedSource = trimmed.replace(/^https?:\/\//i, "");
    return `https://images.weserv.nl/?url=${encodeURIComponent(normalizedSource)}&w=280&h=240&fit=contain&output=jpg`;
}

async function ensureMp3AudioUrl(audioUrl: string): Promise<string | null> {
    const sourceUrl = audioUrl.trim();
    if (!sourceUrl) {
        return null;
    }

    const ffmpegBinary = typeof ffmpegPath === "string" ? ffmpegPath : null;
    if (!ffmpegBinary) {
        logger.error("ffmpeg-static binary is unavailable. Cannot convert audio to mp3.");
        return null;
    }

    const sourceHash = createHash("sha1").update(`${sourceUrl}|${AUDIO_CONVERSION_PROFILE}`).digest("hex");
    const conversionRef = db.collection(MEDIA_CONVERSIONS_COLLECTION).doc(sourceHash);
    const existing = await conversionRef.get();
    if (existing.exists) {
        const existingData = existing.data() as Record<string, unknown>;
        const existingMp3Url = readStringField(existingData, ["mp3Url"]);
        if (existingMp3Url) {
            return existingMp3Url;
        }
    }

    await conversionRef.set({
        sourceUrl,
        status: "processing",
        updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});

    const inputPath = join(tmpdir(), `esp32-audio-${sourceHash}.input`);
    const outputPath = join(tmpdir(), `esp32-audio-${sourceHash}.mp3`);

    try {
        const sourceResponse = await fetch(sourceUrl);
        if (!sourceResponse.ok) {
            throw new Error(`Failed to download audio. HTTP ${sourceResponse.status}`);
        }

        const sourceBuffer = Buffer.from(await sourceResponse.arrayBuffer());
        await writeFile(inputPath, sourceBuffer);

        await execFileAsync(ffmpegBinary, [
            "-y",
            "-i", inputPath,
            "-t", "5",
            "-vn",
            "-acodec", "libmp3lame",
            "-ar", "44100",
            "-ac", "2",
            "-b:a", "128k",
            "-minrate", "128k",
            "-maxrate", "128k",
            "-bufsize", "256k",
            outputPath,
        ]);

        const bucket = getStorage().bucket();
        const destination = `esp32_audio/mp3/${sourceHash}.mp3`;
        const downloadToken = randomUUID();

        await bucket.upload(outputPath, {
            destination,
            metadata: {
                contentType: "audio/mpeg",
                metadata: {
                    firebaseStorageDownloadTokens: downloadToken,
                    sourceAudioUrl: sourceUrl,
                },
            },
        });

        const mp3Url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(destination)}?alt=media&token=${downloadToken}`;

        await conversionRef.set({
            status: "ready",
            mp3Url,
            updatedAt: FieldValue.serverTimestamp(),
        }, {merge: true});

        return mp3Url;
    } catch (error) {
        await conversionRef.set({
            status: "failed",
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: FieldValue.serverTimestamp(),
        }, {merge: true});

        logger.error(`Failed to convert audio to mp3 for ESP32: ${sourceUrl}`, error);
        return null;
    } finally {
        await unlink(inputPath).catch(() => undefined);
        await unlink(outputPath).catch(() => undefined);
    }
}

async function ensureCombinedMp3AudioPath(firstAudio: string, secondAudio: string): Promise<string | null> {
    const firstSource = firstAudio.trim();
    const secondSource = secondAudio.trim();
    if (!firstSource || !secondSource) {
        return null;
    }

    const ffmpegBinary = typeof ffmpegPath === "string" ? ffmpegPath : null;
    if (!ffmpegBinary) {
        logger.error("ffmpeg-static binary is unavailable. Cannot combine audio.");
        return null;
    }

    const sourceHash = createHash("sha1")
        .update(`${firstSource}|${secondSource}|mp3_concat_2step_v1`)
        .digest("hex");
    const conversionRef = db.collection(MEDIA_CONVERSIONS_COLLECTION).doc(sourceHash);
    const existing = await conversionRef.get();
    if (existing.exists) {
        const existingData = existing.data() as Record<string, unknown>;
        const existingCombinedPath = readStringField(existingData, ["combinedPath"]);
        if (existingCombinedPath) {
            return existingCombinedPath;
        }
        const existingMp3Url = readStringField(existingData, ["mp3Url"]);
        if (existingMp3Url) {
            return getStoragePath(existingMp3Url);
        }
    }

    await conversionRef.set({
        sourceAudioA: firstSource,
        sourceAudioB: secondSource,
        status: "processing",
        profile: "mp3_concat_2step_v1",
        updatedAt: FieldValue.serverTimestamp(),
    }, {merge: true});

    const bucket = getStorage().bucket();
    const sourceAPath = firstSource.startsWith("http") ? firstSource : getStoragePath(firstSource).replace(/^\/+/, "");
    const sourceBPath = secondSource.startsWith("http") ? secondSource : getStoragePath(secondSource).replace(/^\/+/, "");

    const inputAPath = join(tmpdir(), `esp32-audio-combine-${sourceHash}-a.input`);
    const inputBPath = join(tmpdir(), `esp32-audio-combine-${sourceHash}-b.input`);
    const outputPath = join(tmpdir(), `esp32-audio-combine-${sourceHash}.mp3`);

    try {
        let sourceABuffer: Buffer;
        if (sourceAPath.startsWith("http")) {
            const response = await fetch(sourceAPath);
            if (!response.ok) {
                throw new Error(`Failed to download first audio. HTTP ${response.status}`);
            }
            sourceABuffer = Buffer.from(await response.arrayBuffer());
        } else {
            if (!sourceAPath) {
                throw new Error("First audio source path is empty.");
            }
            const [downloaded] = await bucket.file(sourceAPath).download();
            sourceABuffer = downloaded;
        }

        let sourceBBuffer: Buffer;
        if (sourceBPath.startsWith("http")) {
            const response = await fetch(sourceBPath);
            if (!response.ok) {
                throw new Error(`Failed to download second audio. HTTP ${response.status}`);
            }
            sourceBBuffer = Buffer.from(await response.arrayBuffer());
        } else {
            if (!sourceBPath) {
                throw new Error("Second audio source path is empty.");
            }
            const [downloaded] = await bucket.file(sourceBPath).download();
            sourceBBuffer = downloaded;
        }

        await writeFile(inputAPath, sourceABuffer);
        await writeFile(inputBPath, sourceBBuffer);

        await execFileAsync(ffmpegBinary, [
            "-y",
            "-i", inputAPath,
            "-i", inputBPath,
            "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]",
            "-map", "[a]",
            "-acodec", "libmp3lame",
            "-ar", "44100",
            "-ac", "2",
            "-b:a", "128k",
            outputPath,
        ]);

        const destination = `esp32_audio/combined/${sourceHash}.mp3`;
        await bucket.upload(outputPath, {
            destination,
            metadata: {
                contentType: "audio/mpeg",
            },
        });

        await conversionRef.set({
            status: "ready",
            combinedPath: destination,
            updatedAt: FieldValue.serverTimestamp(),
        }, {merge: true});

        return destination;
    } catch (error) {
        await conversionRef.set({
            status: "failed",
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: FieldValue.serverTimestamp(),
        }, {merge: true});

        logger.error(`Failed to combine location/user audio for ESP32: ${firstSource} + ${secondSource}`, error);
        return null;
    } finally {
        await unlink(inputAPath).catch(() => undefined);
        await unlink(inputBPath).catch(() => undefined);
        await unlink(outputPath).catch(() => undefined);
    }
}

// async function sanitizeEsp32Payload(eventType: Esp32QueueEventType, payload: Record<string, unknown>): Promise<SanitizedQueueEvent> {
//     const sanitizedPayload: Record<string, unknown> = {...payload};

//     if (eventType === "play_voice") {
//         const audioUrl = readStringField(payload, ["audioUrl"]);
//         if (!audioUrl) {
//             return {
//                 payload: sanitizedPayload,
//                 dropped: true,
//                 dropReason: "Missing audioUrl",
//             };
//         }

//         const finalAudioUrl = isMp3Url(audioUrl) ? audioUrl : await ensureMp3AudioUrl(audioUrl);
//         if (!finalAudioUrl) {
//             return {
//                 payload: sanitizedPayload,
//                 dropped: true,
//                 dropReason: `Audio conversion failed for URL: ${audioUrl}`,
//             };
//         }

//         sanitizedPayload.audioUrl = finalAudioUrl;
//         sanitizedPayload.audioFormat = "mp3";
//     }

//     if (eventType === "play_picture" || eventType === "update_display") {
//         const pictureUrl = readStringField(payload, ["pictureUrl", "picture"]);
//         if (pictureUrl) {
//             const resized = toEsp32ImageUrl(pictureUrl);
//             if (typeof sanitizedPayload.pictureUrl === "string") {
//                 sanitizedPayload.pictureUrl = resized;
//             }
//             if (typeof sanitizedPayload.picture === "string") {
//                 sanitizedPayload.picture = resized;
//             }
//             sanitizedPayload.screenSize = {
//                 width: 280,
//                 height: 240,
//             };
//         }
//     }

//     return {
//         payload: sanitizedPayload,
//         dropped: false,
//     };
// }

// async function sanitizeEsp32Payload(eventType: Esp32QueueEventType, payload: Record<string, unknown>): Promise<SanitizedQueueEvent> {
//     const sanitizedPayload: Record<string, unknown> = {...payload};
//     const bucket = getStorage().bucket();

//     const getStoragePath = (url: string) => {
//         if (!url.startsWith("http")) return url;
//         try {
//             if (url.includes("/o/")) return decodeURIComponent(url.split("/o/")[1].split("?")[0]);
//         } catch (e) { logger.error("Path extraction failed", e); }
//         return url;
//     };

//     if (eventType === "play_voice") {
//         const audioUrl = readStringField(payload, ["audioUrl"]);
//         if (!audioUrl) return { payload: sanitizedPayload, dropped: true, dropReason: "Missing audioUrl" };

//         const finalUrl = isMp3Url(audioUrl) ? audioUrl : await ensureMp3AudioUrl(audioUrl);
//         if (!finalUrl) return { payload: sanitizedPayload, dropped: true, dropReason: "Audio conversion failed" };
        
//         sanitizedPayload.audioUrl = getStoragePath(finalUrl);
//         sanitizedPayload.audioFormat = "mp3";
//     }

//     if (eventType === "play_picture" || eventType === "update_display") {
//         const pictureUrl = readStringField(payload, ["pictureUrl", "picture"]);
//         if (pictureUrl) {
//             if (pictureUrl.startsWith("http") && !pictureUrl.includes("firebasestorage.googleapis.com")) {
//                 try {
//                     const hash = createHash("sha1").update(pictureUrl).digest("hex");
//                     const destination = `esp32_images/${hash}.jpg`;
//                     const file = bucket.file(destination);
                    
//                     const [exists] = await file.exists();
//                     if (!exists) {
//                         const response = await fetch(pictureUrl);
//                         const buffer = Buffer.from(await response.arrayBuffer());
//                         await file.save(buffer, { contentType: "image/jpeg" });
//                     }
//                     sanitizedPayload.pictureUrl = destination;
//                 } catch (e) {
//                     logger.error("Failed to download external image to storage", e);
//                     sanitizedPayload.pictureUrl = toEsp32ImageUrl(pictureUrl); 
//                 }
//             } else {
//                 sanitizedPayload.pictureUrl = getStoragePath(pictureUrl);
//             }
            
//             sanitizedPayload.picture = sanitizedPayload.pictureUrl;
//             sanitizedPayload.screenSize = { width: 280, height: 240 };
//         }
//     }

//     return { payload: sanitizedPayload, dropped: false };
// }

const getStoragePath = (url: string) => {
    if (!url.startsWith("http")) return url;
    try {
        if (url.includes("/o/")) {
            const path = decodeURIComponent(url.split("/o/")[1].split("?")[0]);
            return path.replace(/^\/+/, "");
        }
    } catch (e) {
        console.error("Path extraction failed", e);
    }
    return url;
};

async function sanitizeEsp32Payload(eventType: Esp32QueueEventType, payload: Record<string, unknown>): Promise<SanitizedQueueEvent> {
    const sanitizedPayload: Record<string, unknown> = { ...payload };
    const bucket = getStorage().bucket("wesleys-clock.firebasestorage.app");

    const ensureJpegImagePath = async (imageSource: string, folder: string): Promise<string | null> => {
        const source = imageSource.trim();
        if (!source) {
            return null;
        }

        const imageHash = createHash("sha1").update(source).digest("hex").substring(0, 16);
        const destination = `${folder}/${imageHash}.jpg`;
        const finalPath = destination;
        const outputFile = bucket.file(destination);

        const [alreadyExists] = await outputFile.exists();
        if (alreadyExists) {
            return finalPath;
        }

        const ffmpegBinary = typeof ffmpegPath === "string" ? ffmpegPath : null;
        if (!ffmpegBinary) {
            logger.error("ffmpeg-static binary is unavailable. Cannot convert image to jpeg.");
            return null;
        }

        const inputPath = join(tmpdir(), `esp32-image-${imageHash}.input`);
        const outputPath = join(tmpdir(), `esp32-image-${imageHash}.jpg`);

        try {
            let sourceBuffer: Buffer;
            if (source.startsWith("http")) {
                const response = await fetch(source);
                if (!response.ok) {
                    throw new Error(`Failed to fetch image source. HTTP ${response.status}`);
                }
                sourceBuffer = Buffer.from(await response.arrayBuffer());
            } else {
                const sourcePath = getStoragePath(source).replace(/^\/+/, "");
                if (!sourcePath) {
                    throw new Error("Storage source path is empty.");
                }
                const [downloaded] = await bucket.file(sourcePath).download();
                sourceBuffer = downloaded;
            }

            await writeFile(inputPath, sourceBuffer);
            await execFileAsync(ffmpegBinary, [
                "-y",
                "-i", inputPath,
                "-frames:v", "1",
                "-vf", "scale=70:60:force_original_aspect_ratio=decrease,pad=70:60:(ow-iw)/2:(oh-ih)/2,scale=280:240:flags=neighbor,format=yuvj420p,hue=s=0",
                "-q:v", "31",
                outputPath,
            ]);

            const jpegBuffer = await readFileBuffer(outputPath);
            await outputFile.save(jpegBuffer, {
                metadata: {
                    contentType: "image/jpeg",
                },
            });

            return finalPath;
        } catch (error) {
            logger.error(`Failed to convert image to jpeg for ESP32 source: ${source}`, error);
            return null;
        } finally {
            await unlink(inputPath).catch(() => undefined);
            await unlink(outputPath).catch(() => undefined);
        }
    };

    if (eventType === "play_picture" || eventType === "update_display") {
        const pictureUrl = readStringField(payload, ["pictureUrl", "picture"]);
        if (pictureUrl) {
            let folder = "locations";
            if (payload.sourceCollection === "greetings") {
                folder = "greetings/visual_messages";
            }

            const jpegPath = await ensureJpegImagePath(pictureUrl, folder);
            if (!jpegPath) {
                return {
                    payload: sanitizedPayload,
                    dropped: true,
                    dropReason: `Image conversion to jpeg failed for source: ${pictureUrl}`,
                };
            }
            sanitizedPayload.pictureUrl = jpegPath;
        }

        if (eventType === "update_display" && payload.picture === null && !pictureUrl) {
            sanitizedPayload.picture = null;
        } else {
            sanitizedPayload.picture = sanitizedPayload.pictureUrl;
        }

        sanitizedPayload.screenSize = { width: 280, height: 240 };
    }

    if (eventType === "play_voice") {
        const audioUrl = readStringField(payload, ["audioUrl"]);
        if (!audioUrl) {
            return {
                payload: sanitizedPayload,
                dropped: true,
                dropReason: "Missing audioUrl",
            };
        }

        const storagePathAudio = getStoragePath(audioUrl);
        let finalAudioPath: string | null = null;

        if (audioUrl.startsWith("http")) {
            const convertedUrl = await ensureMp3AudioUrl(audioUrl);
            if (convertedUrl) {
                finalAudioPath = getStoragePath(convertedUrl);
            }
        } else if (isMp3Url(storagePathAudio)) {
            finalAudioPath = storagePathAudio;
        }

        if (!finalAudioPath) {
            return {
                payload: sanitizedPayload,
                dropped: true,
                dropReason: `Audio conversion failed for source: ${audioUrl}`,
            };
        }

        sanitizedPayload.audioUrl = finalAudioPath;
        sanitizedPayload.audioFormat = "mp3";
    }

    return { payload: sanitizedPayload, dropped: false };
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

function normalizeScreenNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3) {
        return value;
    }

    if (typeof value === "string") {
        const parsed = Number.parseInt(value.trim(), 10);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 3) {
            return parsed;
        }
    }

    return null;
}

function readLocationScreenNumber(data: Record<string, unknown>): number | null {
    const screenKeys = ["screenNumber", "screen", "screenId", "screenIndex", "display", "displayIndex", "lcd", "lcdScreen"];
    for (const key of screenKeys) {
        const normalized = normalizeScreenNumber(data[key]);
        if (normalized !== null) {
            return normalized;
        }
    }

    // Backward compatibility for old location docs that still store angles.
    const legacyAngle = readNumericField(data, ["angle"]);
    if (legacyAngle !== null) {
        if (legacyAngle === 0) return 0;
        if (legacyAngle === 90) return 1;
        if (legacyAngle === 180) return 2;
        if (legacyAngle === 270) return 3;
    }

    return null;
}

function readLocationSoundUrl(data: Record<string, unknown>): string | null {
    return readStringField(data, ["soundUrl", "locationSoundUrl", "audioUrl", "sound", "voiceUrl"]);
}

function readPictureUrl(data: Record<string, unknown>): string | null {
    return readStringField(data, ["imageUrl", "greetingUrl", "mediaUrl", "displayGreetingUrl", "pictureUrl"]);
}

function buildLocationPlaceholderImageUrl(locationName: string): string {
    const safeName = locationName.trim() || "Location";
    return `https://placehold.co/280x240/png?text=${encodeURIComponent(safeName)}`;
}

function readAudioUrl(data: Record<string, unknown>): string | null {
    return readStringField(data, ["audioUrl", "mediaUrl", "voiceUrl", "user_voice"]);
}

async function enqueueEsp32Event(input: QueueEventInput): Promise<string> {
    const eventRef = db.collection(ESP32_QUEUE_COLLECTION).doc();
    const sanitized = await sanitizeEsp32Payload(input.eventType, input.payload);

    if (sanitized.dropped) {
        logger.warn(`Dropping ESP32 event '${input.eventType}': ${sanitized.dropReason ?? "Unknown reason"}`);
        return "dropped";
    }

    const queueState = await db.runTransaction(async (transaction) => {
        const stateSnapshot = await transaction.get(ESP32_QUEUE_STATE_DOC);
        const lastSequence = stateSnapshot.data()?.lastSequence;
        const nextSequence = typeof lastSequence === "number" ? lastSequence + 1 : 1;
        const deviceAvailable = stateSnapshot.data()?.deviceAvailable ?? true;

        const eventDoc: Record<string, unknown> = {
            eventType: input.eventType,
            payload: sanitized.payload,
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
            deviceAvailable,
            updatedAt: FieldValue.serverTimestamp(),
        }, {merge: true});

        transaction.set(eventRef, eventDoc);

        return { nextSequence, deviceAvailable };
    });

    await rtdb.ref(ESP32_QUEUE_STATE_RTDB_PATH).set({
        lastSequence: queueState.nextSequence,
        deviceAvailable: queueState.deviceAvailable,
        updatedAt: Date.now(),
    });

    logger.log(`Queued ESP32 event '${input.eventType}' as ${eventRef.id}`);
    return eventRef.id;
}

async function queueStartupSyncEvents(): Promise<{displayEventsQueued: number; handEventsQueued: number}> {
    const locationsSnapshot = await db.collection("locations").get();
    const locationScreenByName = new Map<string, number>();

    let displayEventsQueued = 0;
    for (const locationDoc of locationsSnapshot.docs) {
        const locationData = locationDoc.data() as Record<string, unknown>;
        const screenNumber = readLocationScreenNumber(locationData);
        const locationName = readStringField(locationData, ["locationName", "name"]);

        if (screenNumber === null || !locationName) {
            continue;
        }

        const picture = readPictureUrl(locationData) ?? buildLocationPlaceholderImageUrl(locationName);

        await enqueueEsp32Event({
            eventType: "update_display",
            payload: {
                screenNumber,
                picture,
            },
            sourceCollection: "locations",
            sourceId: locationDoc.id,
        });

        locationScreenByName.set(locationName, screenNumber);
        displayEventsQueued++;
    }

    const usersSnapshot = await db.collection("users").get();
    let handEventsQueued = 0;

    for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data() as Record<string, unknown>;
        const handNumber = readNumericField(userData, ["handNumber"]);

        if (handNumber === null || handNumber < 0 || handNumber > 3) {
            continue;
        }

        const currentLocation = readStringField(userData, ["currentLocation"]);
        const locationScreen = currentLocation ? locationScreenByName.get(currentLocation) : undefined;
        const targetScreenNumber = readNumericField(userData, ["targetScreenNumber"]);

        let screenNumber = -1;
        if (typeof locationScreen === "number") {
            screenNumber = locationScreen;
        } else if (targetScreenNumber !== null && targetScreenNumber >= 0 && targetScreenNumber <= 3) {
            screenNumber = targetScreenNumber;
        }

        await enqueueEsp32Event({
            eventType: "move_clock_hand",
            userId: userDoc.id,
            handNumber,
            payload: {
                handNumber,
                screenNumber,
                locationName: currentLocation ?? null,
            },
            sourceCollection: "users",
            sourceId: userDoc.id,
        });

        handEventsQueued++;
    }

    return {displayEventsQueued, handEventsQueued};
}

/**
 * HTTP Request Function: queueEsp32StateSync
 * Trigger: ESP32 calls this endpoint when it wants to enqueue full state sync.
 * Purpose: Enqueue update_display and move_clock_hand events as normal queue items.
 */
export const queueEsp32StateSync = onRequest(async (request, response) => {
    if (request.method !== "GET") {
        response.status(405).json({error: "Method Not Allowed. Please use GET."});
        return;
    }

    try {
        const syncResult = await queueStartupSyncEvents();

        logger.log(`ESP32 requested state sync. Queued displays: ${syncResult.displayEventsQueued}, hands: ${syncResult.handEventsQueued}.`);

        response.status(200).json({
            status: "success",
            displayEventsQueued: syncResult.displayEventsQueued,
            handEventsQueued: syncResult.handEventsQueued,
        });
    } catch (error) {
        logger.error("Failed to queue ESP32 state sync:", error);
        response.status(500).json({error: "Internal Server Error"});
    }
});

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

    //  Dynamic location validation against Admin GPS settings 
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

        // If the app-provided location is missing or not in Admin settings, store null.
    if (!finalLocation || !allowedLocationNames.includes(finalLocation)) {
            logger.warn(`[Location Warning] User ${finalName} provided location '${finalLocation}' which is not mapped with GPS. Falling back to null.`);
            finalLocation = null;
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
                throw new Error(`No free physical hand available for user ${userId}. Aborting creation.`);
            }

            transaction.set(snapshot.ref, {
            fullName: finalName, 
            currentLocation: finalLocation,
            handNumber: assignedHand,
            status: "active",
            }, { merge: true });
        });

      logger.log(`Transaction completed successfully for user ${userId}`);
    } catch (error) {
      logger.error("Transaction failed critically: ", error);
      // Optional: If you want to delete the invalid doc that was just created:
      await snapshot.ref.delete();
    }
  }
);

/**
 * Trigger: Fires when a new location document is created.
 * Purpose: Automatically assigns the first free screen number from [0, 1, 2, 3].
 */
export const onLocationCreated = onDocumentCreated("locations/{locationId}",
    async (event) => {
        const snapshot = event.data;
        if (!snapshot) {
            logger.log("No data associated with this event");
            return;
        }

        const locationId = event.params.locationId;
        const createdLocationData = snapshot.data() as Record<string, unknown>;
        const locationName = readStringField(createdLocationData, ["locationName", "name"]) ?? "Location";
        const existingPictureUrl = readPictureUrl(createdLocationData);
        const fallbackPictureUrl = existingPictureUrl ?? buildLocationPlaceholderImageUrl(locationName);
        let assignedScreenNumberForQueue: number | null = null;

        try {
            await db.runTransaction(async (transaction) => {
                const locationsSnapshot = await transaction.get(db.collection("locations"));
                const takenScreenNumbers = new Set<number>();

                locationsSnapshot.forEach((doc) => {
                    const docData = doc.data();
                    const existingScreenNumber = readLocationScreenNumber(docData as Record<string, unknown>);

                    if (
                        doc.id !== locationId &&
                        typeof existingScreenNumber === "number" &&
                        [0, 1, 2, 3].includes(existingScreenNumber)
                    ) {
                        takenScreenNumbers.add(existingScreenNumber);
                    }
                });

                let assignedScreenNumber: number | null = null;
                for (const screenNumber of [0, 1, 2, 3]) {
                    if (!takenScreenNumbers.has(screenNumber)) {
                        assignedScreenNumber = screenNumber;
                        break;
                    }
                }

                if (assignedScreenNumber === null) {
                    throw new Error(`No free screen slot available for location ${locationId}. Aborting creation.`);
                }

                const updates: Record<string, unknown> = {
                    screenNumber: assignedScreenNumber,
                };

                if (!existingPictureUrl) {
                    // Ensure newly created locations always have a picture URL for the display flow.
                    updates.imageUrl = fallbackPictureUrl;
                }

                transaction.set(snapshot.ref, updates, { merge: true });

                assignedScreenNumberForQueue = assignedScreenNumber;
            });

            if (assignedScreenNumberForQueue !== null) {
                await enqueueEsp32Event({
                    eventType: "update_display",
                    payload: {
                        screenNumber: assignedScreenNumberForQueue,
                        picture: fallbackPictureUrl,
                    },
                    sourceCollection: "locations",
                    sourceId: locationId,
                });
            }
        } catch (error) {
            logger.error("Failed to auto-assign location screen number:", error);
            await snapshot.ref.delete();
        }
    }
);



/**
 * Trigger: Fires when an existing user document is updated.
 * Purpose 1: Detects location changes, fetches the matching location screen number, and updates targetScreenNumber.
 * Purpose 2: Trigger Queued Messages - Checks if the user arrived "HOME" and releases relevant pending messages.
 * NEW: Validates location against allowed locations and reverts to null if invalid.
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

    // If location is cleared (null/empty), move the hand off-screen and keep location as null.
    if (!afterLocation) {
        const afterDataMap = afterData as Record<string, unknown>;
        const userId = event.params.userId;
        const handNumber = readNumericField(afterDataMap, ["handNumber"]);
        const targetScreenNumber = readNumericField(afterDataMap, ["targetScreenNumber"]);

        logger.log("Location is empty. Setting currentLocation to null and targetScreenNumber to -1.");

        if (afterLocation !== null || targetScreenNumber !== -1) {
            await change.after.ref.set({ targetScreenNumber: -1, currentLocation: null }, { merge: true });
        }

        await enqueueEsp32Event({
            eventType: "move_clock_hand",
            userId,
            handNumber: handNumber === null ? undefined : handNumber,
            payload: {
                handNumber,
                screenNumber: -1,
            },
            sourceCollection: "users",
            sourceId: userId,
        });
        return;
    }

    try {
        //  PART 1: Validate Location and Update targetScreenNumber 
        const locationsRef = db.collection("locations");
        const snapshot = await locationsRef.where("locationName", "==", afterLocation).limit(1).get();

        let targetScreenNumber = -1;
        let finalLocation: string | null = typeof afterLocation === "string" && afterLocation.trim() !== "" ? afterLocation : null;
        let locationDataForQueue: Record<string, unknown> | null = null;

        if (snapshot.empty) {
            // If location is not in the list, force it to null and move hand to -1.
            logger.warn(`Location '${afterLocation}' not found in locations collection. Reverting to null.`);
            finalLocation = null;
        } else {
            const locationDoc = snapshot.docs[0].data() as Record<string, unknown>;
            locationDataForQueue = locationDoc;
            const locationScreenNumber = readLocationScreenNumber(locationDoc);
            if (locationScreenNumber !== null) {
                targetScreenNumber = locationScreenNumber;
                logger.log(`Found location '${afterLocation}' with screenNumber ${targetScreenNumber}`);
            } else {
                logger.warn(`Location '${afterLocation}' found but is missing a valid screen number. Reverting to null and -1.`);
                finalLocation = null;
            }
        }

        // Update both the screen number and the validated location (overwrites invalid locations)
        await change.after.ref.set({ 
            targetScreenNumber: targetScreenNumber,
            currentLocation: finalLocation 
        }, { merge: true });

        logger.log(`Successfully updated user ${event.params.userId} - Location: '${finalLocation}', Screen: ${targetScreenNumber}`);

        const afterDataMap = afterData as Record<string, unknown>;
        const userId = event.params.userId;
        const handNumber = readNumericField(afterDataMap, ["handNumber"]);
        const fallbackScreen = handNumber !== null ? handNumber : undefined;

        if (finalLocation && locationDataForQueue) {
            const screen = readLocationScreenNumber(locationDataForQueue) ?? fallbackScreen;
            await enqueueEsp32Event({
                eventType: "move_clock_hand",
                userId,
                handNumber: handNumber === null ? undefined : handNumber,
                payload: {
                    handNumber,
                    screenNumber: targetScreenNumber,
                    locationName: finalLocation ?? null,
                },
                sourceCollection: "users",
                sourceId: userId,
            });

            const locationSoundUrl = readLocationSoundUrl(locationDataForQueue);
            const userVoiceUrl = readAudioUrl(afterDataMap);
            if (locationSoundUrl && userVoiceUrl) {
                const combinedAudioPath = await ensureCombinedMp3AudioPath(locationSoundUrl, userVoiceUrl);
                if (combinedAudioPath) {
                    await enqueueEsp32Event({
                        eventType: "play_voice",
                        userId,
                        handNumber: handNumber === null ? undefined : handNumber,
                        payload: {
                            screen,
                            audioUrl: combinedAudioPath,
                            source: "location_and_user_combined",
                            locationName: finalLocation,
                        },
                        sourceCollection: "users",
                        sourceId: userId,
                    });
                } else {
                    logger.warn(`Could not combine sounds for user ${userId} at location '${finalLocation}'.`);
                }
            }
        } else {
            await enqueueEsp32Event({
                eventType: "move_clock_hand",
                userId,
                handNumber: handNumber === null ? undefined : handNumber,
                payload: {
                    handNumber,
                    screenNumber: -1,
                    locationName: null,
                },
                sourceCollection: "users",
                sourceId: userId,
            });
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
        //  1. Firestore Cascade Delete: voice_messages 
        const voiceMessagesRef = db.collection("voice_messages");
        // Assuming messages are linked to the user via a "userId" or "senderId" field
        const voiceSnapshot = await voiceMessagesRef.where("userId", "==", userId).get();
        
        if (!voiceSnapshot.empty) {
            const batch = db.batch();
            voiceSnapshot.forEach((doc) => batch.delete(doc.ref));
            await batch.commit();
            logger.log(`Successfully deleted ${voiceSnapshot.size} voice message documents from Firestore.`);
        }

        //  2. Firestore Cascade Delete: visual_greetings (Doodles/Drawings) 
        const visualGreetingsRef = db.collection("visual_greetings");
        const visualSnapshot = await visualGreetingsRef.where("userId", "==", userId).get();
        
        if (!visualSnapshot.empty) {
            const batch = db.batch();
            visualSnapshot.forEach((doc) => batch.delete(doc.ref));
            await batch.commit();
            logger.log(`Successfully deleted ${visualSnapshot.size} visual greeting documents from Firestore.`);
        }

        //  3. Cloud Storage Cleanup: Storage Orphan Prevention 
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
    const deletedLocationScreen = readLocationScreenNumber(deletedLocationData);

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

        // 2. Update all affected users, if any
        if (!usersSnapshot.empty) {
            const batch = db.batch();
            const queueMoves: Promise<string>[] = [];

            usersSnapshot.docs.forEach((doc) => {
                logger.log(`Preparing location reset for user ID: ${doc.id}`);
                const userData = doc.data() as Record<string, unknown>;
                const handNumber = readNumericField(userData, ["handNumber"]);

                batch.update(doc.ref, {
                    currentLocation: null,
                    targetScreenNumber: -1,
                });

                queueMoves.push(enqueueEsp32Event({
                    eventType: "move_clock_hand",
                    userId: doc.id,
                    handNumber: handNumber === null ? undefined : handNumber,
                    payload: {
                        handNumber,
                        screenNumber: -1,
                    },
                    sourceCollection: "users",
                    sourceId: doc.id,
                }));
            });

            await batch.commit();
            await Promise.all(queueMoves);
            logger.log(`Successfully updated ${usersSnapshot.size} users following the deletion of '${deletedLocationName}'.`);
        } else {
            logger.log(`No users were found with currentLocation == '${deletedLocationName}'.`);
        }

        // 3. Always queue display clear for the deleted location screen
        if (deletedLocationScreen !== null) {
            await enqueueEsp32Event({
                eventType: "update_display",
                payload: {
                    screenNumber: deletedLocationScreen,
                    picture: null,
                },
                sourceCollection: "locations",
                sourceId: event.params.locationId,
            });
        } else {
            logger.warn(`Deleted location '${event.params.locationId}' has no valid screenNumber. Skipping display clear queue event.`);
        }

    } catch (error) {
        logger.error("Error occurred during onLocationDeleted execution:", error);
    }
});

/**
 * Trigger: onLocationUpdated
 * Triggers automatically when an ADMIN updates an existing location document in the "locations" collection.
 * Purpose: Cascade Update - If the admin changes a location's name or screenNumber, update all users currently at that location.
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
    const beforeScreenNumber = readLocationScreenNumber(beforeData as Record<string, unknown>);
    const afterScreenNumber = readLocationScreenNumber(afterData as Record<string, unknown>);

    // Optimization: If the admin didn't change the name or the screen number, skip execution to save costs
    if (beforeName === afterName && beforeScreenNumber === afterScreenNumber) {
        logger.log(`No relevant changes (name or screenNumber) for location ID: ${event.params.locationId}. Skipping execution.`);
        return;
    }

    logger.log(`Admin updated location ${event.params.locationId}. Name: '${beforeName}' -> '${afterName}', Screen: ${beforeScreenNumber} -> ${afterScreenNumber}`);

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
        const finalScreenNumber = afterScreenNumber !== null ? afterScreenNumber : 0;
        const finalLocationName = afterName || beforeName; // If name didn't change, keep the old one

        usersSnapshot.docs.forEach((doc) => {
            logger.log(`Updating user ID: ${doc.id} due to admin location change.`);
            
            // Update the user's document with the admin's new settings
            batch.update(doc.ref, {
                currentLocation: finalLocationName,
                targetScreenNumber: finalScreenNumber
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
    if (!snapshot) return;

    const messageData = snapshot.data() as Record<string, unknown>;
    
    const shouldPlayImmediately = true; 
    const newStatus = "ready_to_play";
    
    await snapshot.ref.update({ status: newStatus });

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

        if (currentLocation) {
            const locationSnapshot = await db.collection("locations")
                .where("locationName", "==", currentLocation)
                .limit(1)
                .get();
            if (!locationSnapshot.empty) {
                const locationData = locationSnapshot.docs[0].data() as Record<string, unknown>;
                const locationScreen = readLocationScreenNumber(locationData);
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
                locationName: currentLocation ?? null,
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
 * Purpose: Scans for users with null/empty locations or stale updates and sends them a push notification.
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
                const currentLocation = typeof userData.currentLocation === "string" ? userData.currentLocation : null;
                
                // CRITICAL FIELDS EXPECTED FROM FLUTTER APP:
                const fcmToken = userData.fcmToken; // The Firebase Cloud Messaging token for the device
                const lastUpdatedTimestamp = userData.lastLocationUpdateTime; // A Firestore Timestamp object
                
                let needsAlert = false;

                // Condition 1: Location is explicitly unknown
                if (!currentLocation) {
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
                            title: "The family is waiting to know where you are! ",
                            body: `Hey ${userName}, don't forget to update your location on the clock.`
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
 * If a location is stale, it automatically reverts the user to null
 * and resets their target screen number to -1.
 */
export const flagStaleLocations = onSchedule(
    {
        schedule: "0 * * * *",
        timeZone: "Asia/Jerusalem"
    },
    async (event) => {
        logger.log("Starting hourly check for stale locations...");

        try {
            const usersSnapshot = await db.collection("users").get();
            
            if (usersSnapshot.empty) {
                logger.log("No users found in database. Exiting.");
                return;
            }

            const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;
            const nowMs = Date.now();
            let staleCount = 0;

            for (const doc of usersSnapshot.docs) {
                const userData = doc.data();
                const userId = doc.id; //  NEW: Captured userId for operations 
                const userName = userData.fullName || "Unknown User";
                const currentLocation = typeof userData.currentLocation === "string" ? userData.currentLocation : null;
                const lastUpdatedTimestamp = userData.lastLocationUpdateTime ?? userData.lastUpdated;
                const handNumber = readNumericField(userData, ["handNumber"]); //  NEW: Captured handNumber for ESP32 

                if (!currentLocation) {
                    continue;
                }

                const locationSnapshot = await db.collection("locations")
                    .where("locationName", "==", currentLocation)
                    .limit(1)
                    .get();

                let locationHasGps = false;
                if (!locationSnapshot.empty) {
                    const locationData = locationSnapshot.docs[0].data() as Record<string, unknown>;
                    const latitude = readNumericField(locationData, ["latitude", "lat"]);
                    const longitude = readNumericField(locationData, ["longitude", "lng", "lon"]);
                    locationHasGps = latitude !== null && longitude !== null;
                }

                if (locationHasGps) {
                    continue;
                }

                const isStale = lastUpdatedTimestamp 
                    ? (nowMs - lastUpdatedTimestamp.toDate().getTime() > STALE_THRESHOLD_MS)
                    : true;

                if (isStale) {
                    logger.log(`User '${userName}' has a stale non-GPS location. Resetting.`);

                    
                    // 1. Update Firestore to clear location and target screen
                    await doc.ref.update({
                        currentLocation: null,
                        targetScreenNumber: -1,
                    });

                    // 2. Queue movement to off-screen (-1) via ESP32 event
                    await enqueueEsp32Event({
                        eventType: "move_clock_hand",
                        userId: userId,
                        handNumber: handNumber !== null ? handNumber : undefined,
                        payload: {
                            handNumber: handNumber,
                            screenNumber: -1, // Move to off-screen
                            locationName: null,
                        },
                        sourceCollection: "users",
                        sourceId: userId,
                    });

                    staleCount++;
                }
            }

            if (staleCount > 0) {
                logger.log(`Successfully reset ${staleCount} stale user(s) to null location and moved hands.`);
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
                    //  Step 1: Delete physical audio file from Cloud Storage 
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

                    //  Step 2: Queue the Firestore document for deletion 
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

            //  PART 1: Clear LCD screens for all users 
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

            //  PART 2: Delete expired visual greetings from Firestore and Storage 
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

            //  Commit all updates and deletions together 
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
    //  1. Security Check: Verify user is authenticated 
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
        //  2. Fetch Sender and Target User Data concurrently 
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
        
        //  3. Rate Limiting (7-minute cooldown anti-spam) 
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

        //  4. Verify Target has an FCM Token 
        const fcmToken = targetData?.fcmToken;
        if (!fcmToken) {
            throw new HttpsError(
                "failed-precondition", 
                "Target user does not have a registered device token for notifications."
            );
        }

        //  5. Send the Push Notification via FCM 
        const message = {
            notification: {
                title: "Where are you? ",
                body: `${senderName} is waiting for you to update your location on the family clock!`
            },
            token: fcmToken
        };
        

        await getMessaging().send(message);
        logger.log(`Prompt sent successfully from '${senderName}' to user ID: '${targetUserId}'`);

        //  6. Update the Cooldown Timestamp 
        // We use serverTimestamp() to ensure time accuracy across different devices
        await targetUserRef.update({
            lastPromptedTime: FieldValue.serverTimestamp()
        });

        //  7. Return Success Response to Flutter 
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
 * Purpose: Fetches all active locations and their corresponding screen numbers.
 * Returns: A lightweight JSON object optimized for C++ ArduinoJson parsing.
 */
export const getClockInitConfig = onRequest(async (request, response) => {
    //  1. Restrict to GET requests only 
    // Hardware should only read data, not modify it via this endpoint.
    if (request.method !== "GET") {
        response.status(405).json({ error: "Method Not Allowed. Please use GET." });
        return;
    }

    try {
        logger.log("ESP32 hardware requested clock initialization config.");

        //  2. Fetch all locations from Firestore 
        const locationsSnapshot = await db.collection("locations").get();
        
        // We will build an array of location objects. 
        // This array structure is very easy to parse using ArduinoJson on the ESP32.
        const locationsArray: any[] = [];

        locationsSnapshot.forEach((doc) => {
            const data = doc.data();
            
            const screenNumber = readLocationScreenNumber(data as Record<string, unknown>);

            // Validate that the document actually has the required fields
            if (data.locationName && screenNumber !== null) {
                locationsArray.push({
                    name: data.locationName,
                    screenNumber,
                });
            } else {
                logger.warn(`Skipped invalid location document: ${doc.id}`);
            }
        });

        //  3. Return the JSON payload to the hardware 
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
    //  1. Restrict to POST requests only 
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

        //  2. Update the System Status Document in Firestore 
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

        //  3. Alert the Admin if the severity is CRITICAL 
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
                            title: "⚠️ Hardware Alert: Family Clock",
                            body: `Critical error detected: ${errorMessage || errorCode}. Please check the clock.`
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

        //  4. Acknowledge Receipt to the Hardware 
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
        const claimResult = await db.runTransaction(async (transaction) => {
            const query = db.collection(ESP32_QUEUE_COLLECTION)
                .where("status", "==", "pending")
                .limit(50);

            const queueSnapshot = await transaction.get(query);
            if (queueSnapshot.empty) {
                return {
                    status: "empty" as const,
                };
            }

            const eventDoc = queueSnapshot.docs
                .map((doc) => ({
                    doc,
                    data: doc.data() as Record<string, unknown>,
                }))
                .filter(({data}) => typeof data.sequence === "number")
                .sort((left, right) => (left.data.sequence as number) - (right.data.sequence as number))[0];

            if (!eventDoc) {
                return {
                    status: "empty" as const,
                };
            }

            const eventData = eventDoc.data;
            const sequence = eventData.sequence as number;
            if (sequence === null) {
                transaction.update(eventDoc.doc.ref, {
                    status: "failed",
                    lastError: "Missing sequence",
                    completedAt: FieldValue.serverTimestamp(),
                });
                return {
                    status: "empty" as const,
                };
            }

            transaction.update(eventDoc.doc.ref, {
                status: "processing",
                claimedAt: FieldValue.serverTimestamp(),
            });

            transaction.set(ESP32_QUEUE_STATE_DOC, {
                lastDispatchAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            }, {merge: true});

            return {
                status: "ok" as const,
                eventDocId: eventDoc.doc.id,
                eventData,
                sequence,
            };
        });

        if (claimResult.status === "empty") {
            response.status(200).json({status: "empty"});
            return;
        }

        response.status(200).json({
            status: "ok",
            event: {
                // ESP32 should ACK using this sequence id.
                id: claimResult.sequence,
                sequence: claimResult.sequence,
                queueDocId: claimResult.eventDocId,
                ...claimResult.eventData,
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
        const sequenceIdRaw = request.body?.sequenceId;
        const sequenceId = typeof sequenceIdRaw === "number" ? sequenceIdRaw :
            (typeof sequenceIdRaw === "string" ? Number.parseInt(sequenceIdRaw, 10) : null);
        const wasSuccessful = request.body?.success !== false;
        const isAvailable = request.body?.available !== false;
        const errorMessage = typeof request.body?.errorMessage === "string" ? request.body.errorMessage : null;

        if (!eventId && (sequenceId === null || Number.isNaN(sequenceId))) {
            response.status(400).json({error: "Bad Request. Missing sequenceId or eventId."});
            return;
        }

        const completionResult = await db.runTransaction(async (transaction) => {
            let eventDocIdToComplete: string | null = null;
            let sequenceToAck: number | null = null;

            if (typeof sequenceId === "number" && Number.isFinite(sequenceId)) {
                sequenceToAck = sequenceId;

                const query = db.collection(ESP32_QUEUE_COLLECTION)
                    .where("sequence", "==", sequenceId)
                    .limit(1);
                const result = await transaction.get(query);
                if (!result.empty) {
                    eventDocIdToComplete = result.docs[0].id;
                }
            } else if (eventId) {
                eventDocIdToComplete = eventId;
            }

            if (!eventDocIdToComplete) {
                return {status: "not_found" as const};
            }

            const eventRef = db.collection(ESP32_QUEUE_COLLECTION).doc(eventDocIdToComplete);
            const eventSnapshot = await transaction.get(eventRef);
            if (!eventSnapshot.exists) {
                return {status: "not_found" as const};
            }

            const eventData = eventSnapshot.data() as Record<string, unknown>;
            const eventSequence = typeof eventData.sequence === "number" ? eventData.sequence : null;
            const finalSequence = sequenceToAck ?? eventSequence;

            transaction.set(eventRef, {
                status: wasSuccessful ? "done" : "failed",
                completedAt: FieldValue.serverTimestamp(),
                lastError: errorMessage,
            }, {merge: true});

            transaction.set(ESP32_QUEUE_STATE_DOC, {
                inFlightEventDocId: FieldValue.delete(),
                inFlightSequence: FieldValue.delete(),
                lastAckSequence: finalSequence,
                deviceAvailable: isAvailable,
                updatedAt: FieldValue.serverTimestamp(),
            }, {merge: true});

            return {
                status: "success" as const,
                acknowledgedSequence: finalSequence,
            };
        });

        if (completionResult.status === "not_found") {
            response.status(404).json({error: "Event not found."});
            return;
        }

        response.status(200).json({
            status: "success",
            acknowledgedSequence: completionResult.acknowledgedSequence ?? null,
            available: isAvailable,
        });
    } catch (error) {
        logger.error("Error while completing ESP32 event:", error);
        response.status(500).json({error: "Internal Server Error"});
    }
});