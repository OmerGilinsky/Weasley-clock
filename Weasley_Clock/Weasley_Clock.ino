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
#include <FS.h>
#include <SD.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <TJpg_Decoder.h>
#include <Audio.h>
#include <ESP32Servo.h>

#define WIFI_SSID "Leonid's Fan Club 2.4"
#define WIFI_PASSWORD "leonidOS"

/////////////#define USER_EMAIL
/////////////#define USER_PASSWORD

/////////////#define DATABASE_URL "YOUR_FIREBASE_RTDB_URL"
/////////////#define API_KEY "YOUR_FIREBASE_API_KEY"

/////////////#define COUNTER_PATH
#define FIREBASE_QUEUE 
#define FIREBASE_STORAGE "wesleys-clock.firebasestorage.app"

FirebaseData counter;
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

volatile bool dataChanged = false;

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

#define zeroAngle   0

SPIClass SD_SPI(HSPI);

TFT_eSPI tft = TFT_eSPI();

Audio audio;
bool audioPlaying = false; 

uint8_t currentTargetCS = TFT_CS1;
uint8_t displays[] = {TFT_CS1, TFT_CS2, TFT_CS3, TFT_CS4};

Servo servoMotor1;
Servo servoMotor2;
Servo servoMotor3;
Servo servoMotor4;

Servo hands[] = {servoMotor1, servoMotor2, servoMotor3, servoMotor4}

char* images[] = {"", "", "", ""};
char* locations[] = {"", "", "", ""};
char* names[] = {"", "", "", ""};

uint8_t angles = {zeroAngle, zeroAngle + 45, zeroAngle + 90, zeroAngle + 135};

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

  Serial.printf("Connecting to Firebase");

  config.api_key = API_KEY;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;
  config.database_url = DATABASE_URL;

  config.token_status_callback = tokenStatusCallback;

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  if (!Firebase.RTDB.beginStream(&counter, "/counter"))
    Serial.printf("stream begin error, %s\n\n", counter.errorReason().c_str());

  Firebase.RTDB.setStreamCallback(&counter, streamCallback, streamTimeoutCallback);

  Serial.printf("Connected to " + COUNTER_PATH);
  Serial.println();

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

  servoMotor1.write(angles[0]);
  delay(500);
  servoMotor2.write(angles[0]);
  delay(500);
  servoMotor3.write(angles[0]);
  delay(500);
  servoMotor4.write(angles[0]);
  delay(500);

  Serial.println("Aligned servos");
  Serial.println();
}

//display - the one used to represent the location
//image - 280x240 jpg epresenting the location
//location - mp3 of the name of the location
bool update_location(uint8_t display, char* image, char* location) {
  if (location == "") {
    Serial.println("Removing location from display " + display);
  } else {
    Serial.println("Updating location " + location + " with image " + image + " on display " + display);

    Firebase.ready();

    Firebase.Storage.download(&fbdo, FIREBASE_STORAGE, image, image, mem_storage_type_sd);

    Firebase.ready();

    Firebase.Storage.download(&fbdo, FIREBASE_STORAGE, location, location, mem_storage_type_sd);

    targetDisplay(displays[display]);
    TJpgDec.drawFsJpg(0, 0, image, SD);
  }

  SD.remove(images[display]);
  images[display] = image;

  SD.remove(locations[display]);
  locations[display] = location;

  return 1;
}

//display - the one used to show the picture
//picture - jpg to be shown for 5 seconds
bool show_picture(uint8_t display, char* picture) {
  Serial.println("Showing picture " + picture + " on display " + display);

  Firebase.ready();

  Firebase.Storage.download(&fbdo, FIREBASE_STORAGE, picture, picture, mem_storage_type_sd);

  targetDisplay(displays[display]);
  TJpgDec.drawFsJpg(0, 0, picture, SD);
  delay(5000);
  TJpgDec.drawFsJpg(0, 0, images[display], SD);

  SD.remove(picture);
  return 1;
}

//hand - the one to represent the person
//name - mp3 of the name of the person
bool update_name(uint8_t hand, char* name) {
  if (name = "") {
    Serial.println("Removing name from hand " + hand);
  } else {
    Serial.println("Updating name " + name + " on hand " + hand);

    Firebase.ready();

    Firebase.Storage.download(&fbdo, FIREBASE_STORAGE, name, name, mem_storage_type_sd);

    SD.remove(names[hand]);
  }

  names[hand] = name;

  return 1;
}

//hand - the one represting the person that moved locations
//display - the one that represent the location the person moved to
bool move_hand(uint8_t hand, uint8_t display) {
  Serial.println("Moving hand " + hand + " to display " + display);

  hands[hand].write(angles[display]);

  audio.connecttoFS(SD, names[hand]);
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

  audio.connecttoFS(SD, "/arrived_to.mp3");
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

  audio.connecttoFS(SD, locations[hand]);
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

  return 1;
}

//sound - mp3 to play fully as a messege
bool play_sound(char* sound) {
  Serial.println("Playing sound " + sound);

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

  return 1;
}

void loop() {
  Firebase.ready();

  if (dataChanged)
  {
    dataChanged = false;

    
  }
}
