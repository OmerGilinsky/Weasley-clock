#include "FirebaseCloud.h"
#include "Config.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <FS.h>
#include <SD.h>
#include <ArduinoJson.h>

#include <Firebase_ESP_Client.h>
#include "addons/TokenHelper.h"

// External state declarations from main sketch
struct UserClockState {
    char fullName[64];
    int handNumber;
    int targetAngle;
    int currentAngle;
    char currentLocation[64];
    bool locationChanged;
    char displayGreetingUrl[256];
    bool greetingChanged;
};
extern UserClockState clockUsers[NUM_SERVOS];
extern SemaphoreHandle_t stateMutex;

struct AudioMessage {
    char filePath[128];
};
extern QueueHandle_t audioQueue;

// Firebase objects
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// Internal helpers
void pollUsers();
void pollVoiceMessages();
void queueArrivalAudio(const char* userName, const char* locationName, int handNum);

void initFirebase() {
    Serial.println("[Firebase] Connecting to Wi-Fi...");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    
    int retryCount = 0;
    while (WiFi.status() != WL_CONNECTED && retryCount < 20) {
        delay(500);
        Serial.print(".");
        retryCount++;
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\n[Firebase] Wi-Fi Connected!");
        Serial.print("[Firebase] IP Address: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("\n[Firebase] Wi-Fi Connection Failed! Will retry in task loop.");
    }

    // Configure Firebase
    config.api_key = API_KEY;
    auth.user.email = USER_EMAIL;
    auth.user.password = USER_PASSWORD;
    config.token_status_callback = tokenStatusCallback;

    // Start Firebase Client
    Firebase.begin(&config, &auth);
    Firebase.reconnectWiFi(true);
    Serial.println("[Firebase] Client Initialized.");
}

void TaskFirebase(void *pvParameters) {
    (void)pvParameters;
    
    // Initialize Firebase
    initFirebase();
    
    unsigned long lastPollTime = 0;
    const unsigned long pollInterval = 5000; // Poll every 5 seconds

    for (;;) {
        // Check Wi-Fi and Firebase status
        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("[FirebaseTask] WiFi Disconnected, reconnecting...");
            WiFi.disconnect();
            WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
            vTaskDelay(pdMS_TO_TICKS(5000));
            continue;
        }

        // Wait for Firebase to be ready (Token authenticated)
        if (Firebase.ready()) {
            unsigned long now = millis();
            if (now - lastPollTime >= pollInterval || lastPollTime == 0) {
                lastPollTime = now;
                
                Serial.println("[FirebaseTask] Polling Firestore...");
                pollUsers();
                pollVoiceMessages();
            }
        } else {
            Serial.println("[FirebaseTask] Waiting for Firebase credentials token...");
        }

        vTaskDelay(pdMS_TO_TICKS(1000)); // FreeRTOS yield
    }
}

// Polls the "users" collection for changes
void pollUsers() {
    // listDocuments parameters: (dataObj, projectId, databaseId, collectionId, pageToken)
    if (Firebase.Firestore.listDocuments(&fbdo, PROJECT_ID, "", "users", "")) {
        String payload = fbdo.payload();
        
        // Parse payload using ArduinoJson
        DynamicJsonDocument doc(16384);
        DeserializationError error = deserializeJson(doc, payload);
        if (error) {
            Serial.print("[Firebase] JSON parsing failed: ");
            Serial.println(error.c_str());
            return;
        }

        JsonArray documents = doc["documents"].as<JsonArray>();
        for (JsonObject docUser : documents) {
            String docName = docUser["name"].as<String>();
            JsonObject fields = docUser["fields"].as<JsonObject>();

            if (fields.isNull()) continue;

            // Extract fields
            String fullName = fields["fullName"]["stringValue"].as<String>();
            int handNumber = fields["handNumber"]["integerValue"].as<int>();
            int targetAngle = fields["targetAngle"]["integerValue"].as<int>();
            String currentLocation = fields["currentLocation"]["stringValue"].as<String>();
            String status = fields["status"]["stringValue"].as<String>();
            
            String displayGreetingUrl = "";
            if (fields.containsKey("displayGreetingUrl")) {
                displayGreetingUrl = fields["displayGreetingUrl"]["stringValue"].as<String>();
            }

            // Only update active users with a valid hand (1 to 4)
            if (status == "active" && handNumber >= 1 && handNumber <= 4) {
                int index = handNumber - 1; // 0-indexed

                xSemaphoreTake(stateMutex, portMAX_DELAY);
                
                // 1. Check if target angle or location changed
                if (clockUsers[index].targetAngle != targetAngle || 
                    strcmp(clockUsers[index].currentLocation, currentLocation.c_str()) != 0 ||
                    strcmp(clockUsers[index].fullName, fullName.c_str()) != 0) {
                    
                    Serial.printf("[Firebase] Update for Hand %d (%s): Target Angle: %d, Location: %s\n", 
                                  handNumber, fullName.c_str(), targetAngle, currentLocation.c_str());

                    // Store old location for alert logic
                    String oldLoc = clockUsers[index].currentLocation;

                    // Update local state
                    strncpy(clockUsers[index].fullName, fullName.c_str(), sizeof(clockUsers[index].fullName));
                    clockUsers[index].targetAngle = targetAngle;
                    strncpy(clockUsers[index].currentLocation, currentLocation.c_str(), sizeof(clockUsers[index].currentLocation));
                    clockUsers[index].locationChanged = true;

                    xSemaphoreGive(stateMutex);

                    // If it's a real location change (not initial setup from "Unknown")
                    if (oldLoc != "Unknown" && oldLoc != currentLocation) {
                        queueArrivalAudio(fullName.c_str(), currentLocation.c_str(), handNumber);
                    }
                } else {
                    xSemaphoreGive(stateMutex);
                }

                // 2. Check if visual greeting (doodle) changed
                xSemaphoreTake(stateMutex, portMAX_DELAY);
                if (strcmp(clockUsers[index].displayGreetingUrl, displayGreetingUrl.c_str()) != 0) {
                    Serial.printf("[Firebase] Greeting changed for Hand %d. Old URL: %s, New URL: %s\n",
                                  handNumber, clockUsers[index].displayGreetingUrl, displayGreetingUrl.c_str());
                    
                    strncpy(clockUsers[index].displayGreetingUrl, displayGreetingUrl.c_str(), sizeof(clockUsers[index].displayGreetingUrl));
                    xSemaphoreGive(stateMutex);

                    if (displayGreetingUrl.length() > 0) {
                        // Download the greeting image
                        char greetingPath[64];
                        snprintf(greetingPath, sizeof(greetingPath), "/images/greetings/hand%d.bmp", handNumber);
                        
                        Serial.printf("[Firebase] Downloading custom greeting to SD: %s\n", greetingPath);
                        if (downloadFileToSD(displayGreetingUrl, greetingPath)) {
                            xSemaphoreTake(stateMutex, portMAX_DELAY);
                            clockUsers[index].greetingChanged = true;
                            xSemaphoreGive(stateMutex);
                        }
                    } else {
                        // Greeting cleared (restore normal location screen)
                        xSemaphoreTake(stateMutex, portMAX_DELAY);
                        clockUsers[index].greetingChanged = true;
                        xSemaphoreGive(stateMutex);
                    }
                } else {
                    xSemaphoreGive(stateMutex);
                }
            }
        }
    } else {
        Serial.print("[Firebase] Failed to list users: ");
        Serial.println(fbdo.errorReason());
    }
}

// Polls "voice_messages" collection for pending voice recordings
void pollVoiceMessages() {
    if (Firebase.Firestore.listDocuments(&fbdo, PROJECT_ID, "", "voice_messages", "")) {
        String payload = fbdo.payload();
        
        DynamicJsonDocument doc(8192);
        DeserializationError error = deserializeJson(doc, payload);
        if (error) {
            Serial.print("[Firebase] Messages parsing failed: ");
            Serial.println(error.c_str());
            return;
        }

        JsonArray documents = doc["documents"].as<JsonArray>();
        for (JsonObject docMsg : documents) {
            String docName = docMsg["name"].as<String>();
            JsonObject fields = docMsg["fields"].as<JsonObject>();

            if (fields.isNull()) continue;

            String status = fields["status"]["stringValue"].as<String>();
            if (status == "ready_to_play") {
                String audioUrl = fields["audioUrl"]["stringValue"].as<String>();
                String recipientName = fields["recipientName"]["stringValue"].as<String>();

                Serial.printf("[Firebase] Found voice message for '%s'. Downloading...\n", recipientName.c_str());

                // Prepare SD path
                const char* localPath = "/audio/temp_msg.mp3";
                
                // Download file
                if (downloadFileToSD(audioUrl, localPath)) {
                    Serial.println("[Firebase] Voice message downloaded. Queuing playback...");
                    
                    // Queue for audio task
                    AudioMessage msg;
                    strncpy(msg.filePath, localPath, sizeof(msg.filePath));
                    xQueueSend(audioQueue, &msg, portMAX_DELAY);

                    // Parse document path for status update
                    int idx = docName.indexOf("/documents/");
                    if (idx != -1) {
                        String docPath = docName.substring(idx + 11);
                        Serial.printf("[Firebase] Setting message status to 'played': %s\n", docPath.c_str());
                        
                        FirebaseData updateFbdo;
                        String updateData = "{\"fields\":{\"status\":{\"stringValue\":\"played\"}}}";
                        if (!Firebase.Firestore.patchDocument(&updateFbdo, PROJECT_ID, "", docPath.c_str(), updateData.c_str(), "status")) {
                            Serial.printf("[Firebase] Warning: Failed to update message status: %s\n", updateFbdo.errorReason().c_str());
                        }
                    }
                } else {
                    Serial.println("[Firebase] Error: Voice message download failed!");
                }
            }
        }
    }
}

// Queue sequential arrival audio files
void queueArrivalAudio(const char* userName, const char* locationName, int handNum) {
    AudioMessage msg;

    // 1. User specific chime (e.g. "/audio/users/Alice.mp3")
    snprintf(msg.filePath, sizeof(msg.filePath), "/audio/users/%s.mp3", userName);
    if (!SD.exists(msg.filePath)) {
        // Fallback to generic user sound
        snprintf(msg.filePath, sizeof(msg.filePath), "/audio/users/hand%d.mp3", handNum);
    }
    xQueueSend(audioQueue, &msg, portMAX_DELAY);

    // 2. Constant phrase ("arrived at")
    strncpy(msg.filePath, "/audio/arrived_at.mp3", sizeof(msg.filePath));
    xQueueSend(audioQueue, &msg, portMAX_DELAY);

    // 3. Location sound (e.g. "/audio/locations/HOME.mp3")
    snprintf(msg.filePath, sizeof(msg.filePath), "/audio/locations/%s.mp3", locationName);
    if (!SD.exists(msg.filePath)) {
        // Fallback to general alert sound
        strncpy(msg.filePath, "/audio/locations/default.mp3", sizeof(msg.filePath));
    }
    xQueueSend(audioQueue, &msg, portMAX_DELAY);
}

// Downloads binary file from URL directly to SD card
bool downloadFileToSD(String url, const char* localPath) {
    // Create folders if they don't exist
    String pathStr = String(localPath);
    int lastSlash = pathStr.lastIndexOf('/');
    if (lastSlash != -1) {
        String dirPath = pathStr.substring(0, lastSlash);
        if (!SD.exists(dirPath)) {
            SD.mkdir(dirPath);
        }
    }

    // Delete existing file if present
    if (SD.exists(localPath)) {
        SD.remove(localPath);
    }

    HTTPClient http;
    http.begin(url);
    
    // Set connection timeout
    http.setTimeout(10000); 

    int httpCode = http.GET();
    if (httpCode != HTTP_CODE_OK) {
        Serial.printf("[HTTP] GET failed, error code: %d - %s\n", httpCode, http.errorToString(httpCode).c_str());
        http.end();
        return false;
    }

    // Open file for writing
    File file = SD.open(localPath, FILE_WRITE);
    if (!file) {
        Serial.println("[SD] Failed to open file for writing: " + String(localPath));
        http.end();
        return false;
    }

    WiFiClient* stream = http.getStreamPtr();
    uint8_t buff[1024];
    int len = http.getSize();
    int tempLen = len;
    
    Serial.printf("[HTTP] File size: %d bytes\n", len);

    while (http.connected() && (len > 0 || len == -1)) {
        size_t size = stream->available();
        if (size) {
            int c = stream->readBytes(buff, ((size > sizeof(buff)) ? sizeof(buff) : size));
            file.write(buff, c);
            if (len > 0) len -= c;
        }
        vTaskDelay(pdMS_TO_TICKS(1)); // Yield to other FreeRTOS tasks
    }

    file.close();
    http.end();
    
    Serial.println("[HTTP] Download completed successfully.");
    return true;
}
