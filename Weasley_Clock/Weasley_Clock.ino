//TFT_GND         GND
//TFT_VCC         3V3
//TFT_SCL         D18
//TFT_SDA         D23
//TFT_RES         D4
//TFT_DC          D2
//TFT_CS1         D13
//TFT_CS2         D12
//TFT_CS3         D14
//TFT_CS4         D27
//TFT_BLK         3V3

//I2S_VIN         3V3
//I2C_GND         GND
//I2C_LCK         RX2
//I2C_DIN         TX2
//I2C_BCK         D5

//SD_3V3          3V3
//SD_CS           D15
//SD_MOSI         D26
//SD_CLK          D25
//SD_MISO         D33
//SD_GND          GND

//servo_brown     GND
//servo_red       VIN
//servo_orange1   D19
//servo_orange2   D21
//servo_orange3   D22
//servo_orange4   D32

#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <addons/RTDBHelper.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <FS.h>
#include <SD.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <TJpg_Decoder.h>
#include <Audio.h>
#include <ESP32Servo.h>

#define WIFI_SSID           "Leonid's Fan Club 2.4"
#define WIFI_PASSWORD       "leonidOS"

#define USER_EMAIL          "esp32-wesleys@clock.com"
#define USER_PASSWORD       "123456"

#define DATABASE_URL        "https://wesleys-clock-default-rtdb.firebaseio.com"
#define API_KEY             "AIzaSyAFCIatremITVZz1iRzOEpH7gUicLCJ8Iw"
#define POP_NEXT_EVENT_URL  "https://us-central1-wesleys-clock.cloudfunctions.net/popNextEsp32Event"
#define COMPLETE_EVENT_URL  "https://us-central1-wesleys-clock.cloudfunctions.net/completeEsp32Event"

#define FIREBASE_COUNTER    ""
#define FIREBASE_STORAGE    "wesleys-clock.firebasestorage.app"

#define TFT_CS1     13
#define TFT_CS2     12
#define TFT_CS3     14
#define TFT_CS4     27

#define I2S_DOUT    17
#define I2S_BCLK    19
#define I2S_LRC     16

#define SD_CLK      25
#define SD_MISO     33
#define SD_MOSI     26
#define SD_CS       15

#define servo_PWM1  5
#define servo_PWM2  21
#define servo_PWM3  22
#define servo_PWM4  32

FirebaseData counter;
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

volatile bool dataChanged = false;

SPIClass SD_SPI(HSPI);

TFT_eSPI tft = TFT_eSPI();

uint8_t currentTargetCS = TFT_CS1;
uint8_t displays[] = {TFT_CS1, TFT_CS2, TFT_CS3, TFT_CS4};

const char* images[] = {"", "", "", ""};

Audio audio;
bool audioPlaying = false; 

Servo servoMotor1;
Servo servoMotor2;
Servo servoMotor3;
Servo servoMotor4;

Servo hands[] = {servoMotor1, servoMotor2, servoMotor3, servoMotor4};

int angles1[] = {22, 1, 45, 96, 143};
int angles2[] = {22, 0, 48, 94, 141};
int angles3[] = {25, 3, 51, 98, 143};
int angles4[] = {17, 0, 33, 67, 105};

bool tft_output(int16_t x, int16_t y, uint16_t w, uint16_t h, uint16_t* bitmap) {
  if (y >= tft.height()) return 0;

  digitalWrite(currentTargetCS, LOW);
  tft.pushImage(x, y, w, h, bitmap);
  digitalWrite(currentTargetCS, HIGH);
  
  return 1;
}

void targetDisplay(uint8_t targetCsPin) {
  currentTargetCS = targetCsPin;
}

void streamCallback(FirebaseStream data)
{
  Serial.printf("sream path, %s\nevent path, %s\ndata type, %s\nevent type, %s\n\n",
                data.streamPath().c_str(),
                data.dataPath().c_str(),
                data.dataType().c_str(),
                data.eventType().c_str());
  printResult(data);
  Serial.println();

  Serial.printf("Received stream payload size: %d (Max. %d)\n\n", data.payloadLength(), data.maxPayloadLength());

  dataChanged = true;
}

void streamTimeoutCallback(bool timeout)
{
  if (timeout)
    Serial.println("stream timed out, resuming...\n");

  if (!counter.httpConnected())
    Serial.printf("error code: %d, reason: %s\n\n", counter.httpCode(), counter.errorReason().c_str());
}

void setup() {
  Serial.begin(115200);

  SD_SPI.begin(SD_CLK, SD_MISO, SD_MOSI, SD_CS);

  Serial.println("Mounting SD Card");
  if (!SD.begin(SD_CS, SD_SPI)) {
    Serial.println("SD Card mounted failed");
    return;
  }
  Serial.println("SD Card mounted successfully");
  Serial.println();

  Serial.println("Turning on displays");

  pinMode(TFT_CS1, OUTPUT);
  pinMode(TFT_CS2, OUTPUT);
  pinMode(TFT_CS3, OUTPUT);
  pinMode(TFT_CS4, OUTPUT);

  tft.init();
  tft.setRotation(0);

  digitalWrite(TFT_CS1, HIGH);
  digitalWrite(TFT_CS2, HIGH);
  digitalWrite(TFT_CS3, HIGH);
  digitalWrite(TFT_CS4, HIGH);

  for (int i = 0; i < 4; i++) {
    digitalWrite(displays[i], LOW);
    tft.fillScreen(TFT_BLACK);
    digitalWrite(displays[i], HIGH);
  }

  TJpgDec.setSwapBytes(true);
  TJpgDec.setCallback(tft_output);

  Serial.println("Turned on displays");
  Serial.println();

  Serial.println("Setting audio");

  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(20);

  Serial.println("Audio set");
  Serial.println();

  Serial.println("Aligning servos");

  servoMotor1.attach(servo_PWM1);
  servoMotor2.attach(servo_PWM2);
  servoMotor3.attach(servo_PWM3);
  servoMotor4.attach(servo_PWM4);

  servoMotor1.write(angles1[0]);
  delay(1000);
  servoMotor2.write(angles2[0]);
  delay(1000);
  servoMotor3.write(angles3[0]);
  delay(1000);
  servoMotor4.write(angles4[0]);
  delay(1000);

  Serial.println("Aligned servos");
  Serial.println();

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED)
  {
    Serial.print(".");
    delay(300);
  }
  Serial.println();
  Serial.print("Connected with IP: ");
  Serial.println(WiFi.localIP());
  Serial.println();

  Serial.print("Connecting to Firebase");

  config.api_key = API_KEY;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;
  config.database_url = DATABASE_URL;

  config.token_status_callback = tokenStatusCallback;

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  if (!Firebase.RTDB.beginStream(&counter, FIREBASE_COUNTER))
    Serial.printf("stream begin error, %s\n\n", counter.errorReason().c_str());

  Firebase.RTDB.setStreamCallback(&counter, streamCallback, streamTimeoutCallback);

  Serial.print("Connected to ");
  Serial.print(FIREBASE_COUNTER);
  Serial.println();

  Serial.println("Moving to loop");
  Serial.println();
}

//display, int{0-4} - the one used to represent the location
//image, char* - 280x240 jpg epresenting the location
void update_display(int display, const char* image) {
  if (image == nullptr) {
    Serial.print("Removing location from display ");
    Serial.println(display);

    tft.fillScreen(TFT_BLACK);

    SD.remove(images[display]);
    images[display] = "";

  } else {
    Serial.print("Updating display ");
    Serial.print(display);
    Serial.print(" with image ");
    Serial.println(image);

    Firebase.ready();

    Firebase.Storage.download(&fbdo, FIREBASE_STORAGE, image, image, mem_storage_type_sd);

    targetDisplay(displays[display]);
    TJpgDec.drawFsJpg(0, 0, image, SD);

    SD.remove(images[display]);
    images[display] = image;
  }
}

//display, int{0-4} - the one used to show the picture
//picture, char* - jpg to be shown for 5 seconds
void show_picture(int display, const char* picture) {
  Serial.print("Showing picture ");
  Serial.print(picture);
  Serial.print(" on display ");
  Serial.println(display);

  Firebase.ready();

  Firebase.Storage.download(&fbdo, FIREBASE_STORAGE, picture, picture, mem_storage_type_sd);

  targetDisplay(displays[display]);
  TJpgDec.drawFsJpg(0, 0, picture, SD);
  delay(5000);
  TJpgDec.drawFsJpg(0, 0, images[display], SD);

  SD.remove(picture);
}

//hand, int{1-4} - the one represting the person that moved locations
//display, int{0-4} - the one that represent the location the person moved to
void move_hand(int hand, int display) {
  Serial.print("Moving hand ");
  Serial.print(hand);
  Serial.print(" to display ");
  Serial.println(display);

  switch(hand) {
    case 1: hands[hand].write(angles1[display]); break;
    case 2: hands[hand].write(angles2[display]); break;
    case 3: hands[hand].write(angles3[display]); break;
    case 4: hands[hand].write(angles4[display]); break;
  }
}

//sound, char* - mp3 to play fully as a messege
void play_sound(const char* sound) {
  Serial.print("Playing sound ");
  Serial.println(sound);

  Firebase.ready();

  Firebase.Storage.download(&fbdo, FIREBASE_STORAGE, sound, sound, mem_storage_type_sd);
  
  audio.connecttoFS(SD, sound);
  while (true) {
    audio.loop();
    if (audio.isRunning()) {
      audioPlaying = true;
    } else if (audioPlaying && !audio.isRunning()) {
      audio.stopSong();
      audioPlaying = false;
      break;
    }
  }

  SD.remove(sound);
}

bool fetchAndExecuteNextEvent() {
  HTTPClient httpPop;
  httpPop.begin(POP_NEXT_EVENT_URL);

  int httpPopResponseCode = httpPop.GET();
  bool moreEvents = false;

  if (httpPopResponseCode > 0) {
    String jsonResponse = httpPop.getString();
    Serial.println("Received JSON: " + jsonResponse);

    JsonDocument doc; 
    DeserializationError error = deserializeJson(doc, jsonResponse);

    if (error) {
      Serial.print("deserializeJson() failed: ");
      Serial.println(error.c_str());
      httpPop.end();
      return false; // Break the while loop
    }

    const char* status = doc["status"]; 

    if (String(status) == "ok") {
      const char* eventType = doc["event"]["eventType"];
      int eventId = doc["event"]["id"];
      const char* queueDocId = doc["event"]["queueDocId"];

      Serial.print("Event Type: ");
      Serial.println(eventType);

      if (String(eventType) == "move_clock_hand") {
        int handNumber = doc["event"]["payload"]["handNumber"];
        int screenNumber = doc["event"]["payload"]["screenNumber"];
        
        move_hand(handNumber, screenNumber);
      } 
      else if (String(eventType) == "update_display") {
        int screenNumber = doc["event"]["payload"]["screenNumber"];
        const char* picture = doc["event"]["payload"]["picture"];
        
        update_display(screenNumber, picture);
      }
      else if (String(eventType) == "play_picture") {
        int screenNumber = doc["event"]["payload"]["screenNumber"];
        const char* pictureUrl = doc["event"]["payload"]["pictureUrl"];
        
        show_picture(screenNumber, pictureUrl);
      }
      else if (String(eventType) == "play_voice") {
        const char* audioUrl = doc["event"]["payload"]["audioUrl"];
        
        play_sound(audioUrl);
      }
      
      HTTPClient httpComplete;
      httpComplete.begin(COMPLETE_EVENT_URL);
      httpComplete.addHeader("Content-Type", "application/json");

      // Build the JSON payload to send back to the server
      JsonDocument completeDoc;
      completeDoc["eventId"] = queueDocId; 
      completeDoc["sequenceId"] = eventId; 
      completeDoc["status"] = "success";
      completeDoc["errorMessage"] = nullptr;
      
      String requestBody;
      serializeJson(completeDoc, requestBody);

      // Send the POST request
      int completeResponseCode = httpComplete.POST(requestBody);
      
      if (completeResponseCode > 0) {
        Serial.printf("Successfully completed event %d. Server responded: %d\n", eventId, completeResponseCode);
      } else {
        Serial.printf("Failed to complete event %d. Error code: %d\n", eventId, completeResponseCode);
      }
      
      httpComplete.end();
      
      moreEvents = true; // Tell the while loop to run again for the next item
    } 
    else if (String(status) == "empty") {
      Serial.println("Queue is empty. Done processing.");
      moreEvents = false; // Stop the loop
    } 
    else if (String(status) == "wait") {
      Serial.println("Device is busy or unavailable. Waiting.");
      moreEvents = false; // Stop the loop
    }
  } 
  else {
    Serial.print("Error code on HTTP Request: ");
    Serial.println(httpPopResponseCode);
    moreEvents = false; // Error occurred, break the loop
  }

  httpPop.end();

  return moreEvents;
}

void loop() {
  Firebase.ready();

  if (!Firebase.RTDB.readStream(&counter)) {
    Serial.println("No stream");
  }

  if (dataChanged)
  {
    dataChanged = false;

    Serial.println("Queue change recognized");

    bool keepExecuting = true;

    while (keepExecuting) {
      keepExecuting = fetchAndExecuteNextEvent();
      delay(500);
    }
    
  }
}
