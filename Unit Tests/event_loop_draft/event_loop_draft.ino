/*
  =============================================================================
  Weasley Clock - ESP32 Event Pulling, Processing and Completion Draft
  =============================================================================
  
  This draft implements a non-blocking event-driven client that:
  1. Polls the Cloud Function `popNextEsp32Event` every X seconds.
  2. Parses the incoming JSON payload (using ArduinoJson v6).
  3. Executes the corresponding action:
     - "move_clock_hand": Moves the servo motor to the target angle.
     - "play_voice": Downloads the voice file to the SD card and plays it.
  4. Once the action is complete, notifies the cloud using the `completeEsp32Event` endpoint.
  
  Note: This code runs on a single-threaded non-blocking loop (using millis())
  so that it does not block the servos or stutter I2S audio playback.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <FS.h>
#include <SD.h>
#include <SPI.h>
#include <ESP32Servo.h>
#include <Audio.h>
#include <ArduinoJson.h>

// =============================================================================
// 1. Wi-Fi & Cloud Functions Configuration
// =============================================================================
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Cloud function base URL. Replace with your actual Firebase project region and ID.
#define CLOUD_FUNCTIONS_BASE_URL "https://us-central1-wesleys-clock.cloudfunctions.net"

const unsigned long POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
unsigned long lastPollTime = 0;

// =============================================================================
// 2. Hardware Configuration (Unit Tests vs Final Integrated Board)
// =============================================================================
// Set to 1 to use individual UNITESTS pinouts, or 0 to use the integrated board pinout from Config.h
#define USE_UNITESTS_PINS 1

#if USE_UNITESTS_PINS
  // Pinout from Unit Tests (I2S_and_TFT_SD & MG995 tests)
  #define SD_CLK    25
  #define SD_MISO   33
  #define SD_MOSI   26
  #define SD_CS     15

  #define I2S_DOUT  17
  #define I2S_BCLK  5
  #define I2S_LRC   16

  const int SERVO_PINS[4] = {16, 17, 21, 22}; // Note: Unit tests had pin 17/16 conflict when combined
#else
  // Pinout from integrated wesleys_clock_esp32/Config.h
  #define SD_CLK    18
  #define SD_MISO   19
  #define SD_MOSI   23
  #define SD_CS     5

  #define I2S_DOUT  22
  #define I2S_BCLK  26
  #define I2S_LRC   25

  const int SERVO_PINS[4] = {13, 12, 14, 27};
#endif

// =============================================================================
// 3. Global Hardware Instances & States
// =============================================================================
SPIClass SD_SPI(HSPI);
Audio audio;
Servo servos[4];

// Servo movement state tracking (for smooth non-blocking sweeping)
int servoCurrentAngles[4] = {0, 0, 0, 0};
int servoTargetAngles[4]  = {0, 0, 0, 0};
unsigned long lastMotorStepTime = 0;
const unsigned long MOTOR_STEP_DELAY_MS = 25; // Milliseconds per 1 degree change

// =============================================================================
// 3. Servo Calibration & Offset Mapping (5 Locations)
// =============================================================================
// The 5 logical locations on the clock face (in degrees)
const int LOGICAL_ANGLES[5] = { 0, 72, 144, 216, 288 };

// 2D Calibration matrix: [handIndex][locationIndex]
// For each of the 4 hands, define the exact physical write value (usually 0 to 180)
// corresponding to the 5 logical locations: 0°, 72°, 144°, 216°, and 288°.
// Adjust these physical write values for each hand to perfectly align them!
const int SERVO_PHYSICAL_MAP[4][5] = {
  // Hand 1 (Calibrate physical values for logical: 0°, 72°, 144°, 216°, 288°)
  { 0,   72,  144,  180,  180 }, 
  
  // Hand 2 (Calibrate physical values for logical: 0°, 72°, 144°, 216°, 288°)
  { 5,   76,  140,  175,  175 }, 
  
  // Hand 3 (Calibrate physical values for logical: 0°, 72°, 144°, 216°, 288°)
  { 10,  80,  148,  180,  180 }, 
  
  // Hand 4 (Calibrate physical values for logical: 0°, 72°, 144°, 216°, 288°)
  { 2,   70,  138,  172,  172 }  
};

// Helper function to map logical target angle to calibrated physical servo write value
int mapLogicalToPhysicalAngle(int handIndex, int logicalAngle) {
  // Piece-wise linear mapping between the 5 calibration points
  if (logicalAngle <= LOGICAL_ANGLES[0]) {
    return SERVO_PHYSICAL_MAP[handIndex][0];
  }
  
  // Interval 1: 0 to 72
  if (logicalAngle <= LOGICAL_ANGLES[1]) {
    return map(logicalAngle, LOGICAL_ANGLES[0], LOGICAL_ANGLES[1], 
               SERVO_PHYSICAL_MAP[handIndex][0], SERVO_PHYSICAL_MAP[handIndex][1]);
  }
  
  // Interval 2: 72 to 144
  if (logicalAngle <= LOGICAL_ANGLES[1] + 72) { // 72 to 144
    return map(logicalAngle, LOGICAL_ANGLES[1], LOGICAL_ANGLES[2], 
               SERVO_PHYSICAL_MAP[handIndex][1], SERVO_PHYSICAL_MAP[handIndex][2]);
  }
  
  // Interval 3: 144 to 216
  if (logicalAngle <= LOGICAL_ANGLES[2] + 72) { // 144 to 216
    return map(logicalAngle, LOGICAL_ANGLES[2], LOGICAL_ANGLES[3], 
               SERVO_PHYSICAL_MAP[handIndex][2], SERVO_PHYSICAL_MAP[handIndex][3]);
  }
  
  // Interval 4: 216 to 288
  if (logicalAngle <= LOGICAL_ANGLES[3] + 72) { // 216 to 288
    return map(logicalAngle, LOGICAL_ANGLES[3], LOGICAL_ANGLES[4], 
               SERVO_PHYSICAL_MAP[handIndex][3], SERVO_PHYSICAL_MAP[handIndex][4]);
  }
  
  // Beyond 288
  return SERVO_PHYSICAL_MAP[handIndex][4];
}

// Path on SD to save downloaded messages
const char* AUDIO_TEMP_PATH = "/audio/temp_msg.mp3";

// Queue Event Status Tracking
bool isProcessingEvent = false;
String currentEventId = "";
String currentEventType = "";

// State indicators for completing operations
bool isMotorMoving = false;
bool isAudioPlaying = false;

// =============================================================================
// 4. Function Prototypes
// =============================================================================
void connectWiFi();
void initHardware();
void pollCloudEvent();
void handleEvent(JsonObject event);
void updateServosNonBlocking();
void checkPlaybackFinished();
bool downloadFileToSD(String url, const char* path);
void sendEventCompletion(String eventId, bool success, String errorMessage = "");

// =============================================================================
// 5. Setup & Loop
// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- Booting Weasley Clock Event-Loop Client ---");

  // Initialize Wi-Fi
  connectWiFi();

  // Initialize hardware components
  initHardware();
  
  Serial.println("System initialized. Starting Loop...");
}

void loop() {
  // Feed I2S audio buffer continuously (essential for smooth playback)
  audio.loop();

  // Handle smooth non-blocking servo movement
  updateServosNonBlocking();

  // Check if current audio playback has finished, to mark the event completed
  checkPlaybackFinished();

  // Non-blocking timer for polling cloud events
  if (!isProcessingEvent) {
    unsigned long currentMillis = millis();
    if (currentMillis - lastPollTime >= POLL_INTERVAL_MS || lastPollTime == 0) {
      lastPollTime = currentMillis;
      pollCloudEvent();
    }
  }
}

// =============================================================================
// 6. WiFi & API Client Implementation
// =============================================================================
void connectWiFi() {
  Serial.printf("Connecting to WiFi: %s ", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
}

// Polls the server for the next event
void pollCloudEvent() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Connection lost. Skipping poll.");
    return;
  }

  HTTPClient http;
  String url = String(CLOUD_FUNCTIONS_BASE_URL) + "/popNextEsp32Event";
  
  Serial.println("[API] Polling cloud for next event...");
  http.begin(url);
  http.setTimeout(8000); // 8 seconds timeout

  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    
    // Parse response JSON
    DynamicJsonDocument doc(2048);
    DeserializationError error = deserializeJson(doc, payload);
    if (error) {
      Serial.printf("[JSON] Parsing failed: %s\n", error.c_str());
      http.end();
      return;
    }

    String status = doc["status"].as<String>();
    if (status == "ok") {
      JsonObject event = doc["event"].as<JsonObject>();
      handleEvent(event);
    } else {
      // "empty" or other status
      Serial.println("[API] Queue is empty. No events pending.");
    }
  } else {
    Serial.printf("[API] GET request failed, httpCode: %d (Error: %s)\n", 
                  httpCode, http.errorToString(httpCode).c_str());
  }
  http.end();
}

// Sends event completion status back to Cloud Function
void sendEventCompletion(String eventId, bool success, String errorMessage) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Disconnected. Cannot send event completion!");
    return;
  }

  HTTPClient http;
  String url = String(CLOUD_FUNCTIONS_BASE_URL) + "/completeEsp32Event";
  
  Serial.printf("[API] Reporting completion for event %s (Success: %s)...\n", 
                eventId.c_str(), success ? "TRUE" : "FALSE");
                
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  // Create JSON request body
  DynamicJsonDocument doc(256);
  doc["eventId"] = eventId;
  doc["success"] = success;
  if (!success && errorMessage.length() > 0) {
    doc["errorMessage"] = errorMessage;
  }

  String jsonStr;
  serializeJson(doc, jsonStr);

  int httpCode = http.POST(jsonStr);
  if (httpCode == HTTP_CODE_OK) {
    String response = http.getString();
    Serial.printf("[API] Complete confirmation response: %s\n", response.c_str());
    
    // Reset event processing state
    isProcessingEvent = false;
    currentEventId = "";
    currentEventType = "";
  } else {
    Serial.printf("[API] POST complete failed, httpCode: %d (Error: %s)\n", 
                  httpCode, http.errorToString(httpCode).c_str());
    // In production, you might want to retry this API call if it fails
  }
  http.end();
}

// =============================================================================
// 7. Event Handler & Dispatcher
// =============================================================================
void handleEvent(JsonObject event) {
  currentEventId = event["id"].as<String>();
  currentEventType = event["eventType"].as<String>();
  JsonObject payload = event["payload"].as<JsonObject>();

  Serial.printf("\n[Event] Received event [%s] of type: %s\n", 
                currentEventId.c_str(), currentEventType.c_str());

  isProcessingEvent = true;

  if (currentEventType == "move_clock_hand") {
    // Expected payload: { "handNumber": 1, "angle": 90, "locationName": "Work" }
    int handNum = payload["handNumber"].as<int>();
    int angle = payload["angle"].as<int>();
    String locationName = payload["locationName"].as<String>();

    Serial.printf("[Motor] Order: Move hand %d to %d degrees (%s)\n", 
                  handNum, angle, locationName.c_str());

    if (handNum >= 1 && handNum <= 4) {
      int index = handNum - 1;
      
      // Target angle boundary safety clamp (MG995 180-deg servo)
      if (angle < 0) angle = 0;
      if (angle > 180) angle = 180;

      servoTargetAngles[index] = angle;
      isMotorMoving = true;
    } else {
      Serial.println("[Motor] Error: Invalid handNumber in payload.");
      sendEventCompletion(currentEventId, false, "Invalid handNumber");
    }

  } else if (currentEventType == "play_voice") {
    // Expected payload: { "audioUrl": "https://..." }
    String audioUrl = payload["audioUrl"].as<String>();
    
    Serial.printf("[Audio] Order: Play voice file from %s\n", audioUrl.c_str());

    // 1. Download file to SD card
    if (downloadFileToSD(audioUrl, AUDIO_TEMP_PATH)) {
      // 2. Play file
      Serial.printf("[Audio] Playing local file: %s\n", AUDIO_TEMP_PATH);
      audio.connecttoFS(SD, AUDIO_TEMP_PATH);
      isAudioPlaying = true;
    } else {
      Serial.println("[Audio] Error: Download failed.");
      sendEventCompletion(currentEventId, false, "Download failed");
    }

  } else {
    // Other event types (like reset_screen, play_picture etc. can be expanded here)
    Serial.printf("[Event] Skipping unsupported event type: %s\n", currentEventType.c_str());
    sendEventCompletion(currentEventId, true); // complete to clear it from queue
  }
}

// =============================================================================
// 8. Physical Control (Servos & Audio Check)
// =============================================================================

// Non-blocking servo update function
void updateServosNonBlocking() {
  if (!isMotorMoving) return;

  unsigned long currentMillis = millis();
  if (currentMillis - lastMotorStepTime >= MOTOR_STEP_DELAY_MS) {
    lastMotorStepTime = currentMillis;
    bool allMotorsDone = true;

    for (int i = 0; i < 4; i++) {
      if (servoCurrentAngles[i] != servoTargetAngles[i]) {
        allMotorsDone = false;
        
        int delta = servoTargetAngles[i] - servoCurrentAngles[i];
        int step = (delta > 0) ? 1 : -1;
        
        servoCurrentAngles[i] += step;
        
        // Calibrate step: map current logical angle to physical angle for this servo
        int physicalAngle = mapLogicalToPhysicalAngle(i, servoCurrentAngles[i]);
        servos[i].write(physicalAngle);
      }
    }

    if (allMotorsDone && isMotorMoving) {
      Serial.println("[Motor] Movement complete.");
      isMotorMoving = false;
      
      // If we are currently handling a motor movement event, notify completion
      if (isProcessingEvent && currentEventType == "move_clock_hand") {
        sendEventCompletion(currentEventId, true);
      }
    }
  }
}

// Checks if audio finishes playing
void checkPlaybackFinished() {
  if (isAudioPlaying && !audio.isRunning()) {
    Serial.println("[Audio] Playback finished.");
    isAudioPlaying = false;
    
    // Delete temporary file to save space
    if (SD.exists(AUDIO_TEMP_PATH)) {
      SD.remove(AUDIO_TEMP_PATH);
      Serial.println("[Audio] Temporary audio file deleted.");
    }

    // If we are processing a play_voice event, report completion
    if (isProcessingEvent && currentEventType == "play_voice") {
      sendEventCompletion(currentEventId, true);
    }
  }
}

// =============================================================================
// 9. Hardware Initialization
// =============================================================================
void initHardware() {
  // 1. Initialize SD Card
  Serial.println("[SD] Initializing SD Card...");
  SD_SPI.begin(SD_CLK, SD_MISO, SD_MOSI, SD_CS);
  if (!SD.begin(SD_CS, SD_SPI)) {
    Serial.println("[SD] ERROR: SD Card Mount Failed!");
  } else {
    Serial.println("[SD] SD Card Mounted successfully.");
    
    // Ensure folders exist
    if (!SD.exists("/audio")) {
      SD.mkdir("/audio");
    }
  }

  // 2. Initialize Audio DAC
  Serial.println("[Audio] Initializing I2S DAC...");
  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(12); // Volume range: 0 to 21

  // 3. Initialize Servo Motors
  Serial.println("[Servos] Initializing Servo Motors...");
  // ESP32 requires PWM timer allocations for ESP32Servo library
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  for (int i = 0; i < 4; i++) {
    servos[i].setPeriodHertz(50); // Standard 50Hz servo signal
    servos[i].attach(SERVO_PINS[i], 500, 2400); // Standard pulse width
    
    // Calibrate start position: map logical 0 to physical offset zero
    int startPhysicalAngle = mapLogicalToPhysicalAngle(i, 0);
    servos[i].write(startPhysicalAngle); 
    
    servoCurrentAngles[i] = 0;
    servoTargetAngles[i] = 0;
    Serial.printf("[Servos] Servo %d attached to Pin %d (Calibrated 0 => Physical %d)\n", 
                  i + 1, SERVO_PINS[i], startPhysicalAngle);
  }
}

// =============================================================================
// 10. File Downloader Implementation
// =============================================================================
bool downloadFileToSD(String url, const char* path) {
  Serial.printf("[HTTP] Downloading file: %s -> %s\n", url.c_str(), path);

  // Delete existing file if present
  if (SD.exists(path)) {
    SD.remove(path);
  }

  HTTPClient http;
  http.begin(url);
  http.setTimeout(15000); // 15 seconds timeout for download

  int httpCode = http.GET();
  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("[HTTP] GET failed, code: %d (Error: %s)\n", 
                  httpCode, http.errorToString(httpCode).c_str());
    http.end();
    return false;
  }

  File file = SD.open(path, FILE_WRITE);
  if (!file) {
    Serial.println("[SD] Failed to open file for writing.");
    http.end();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buff[1024];
  int len = http.getSize();
  int remaining = len;

  Serial.printf("[HTTP] File size: %d bytes\n", len);

  while (http.connected() && (remaining > 0 || len == -1)) {
    size_t size = stream->available();
    if (size) {
      int c = stream->readBytes(buff, ((size > sizeof(buff)) ? sizeof(buff) : size));
      file.write(buff, c);
      if (remaining > 0) remaining -= c;
    }
    // Yield to avoid software watchdog reset during download
    vTaskDelay(pdMS_TO_TICKS(1));
  }

  file.close();
  http.end();
  Serial.println("[HTTP] Download completed successfully.");
  return true;
}
