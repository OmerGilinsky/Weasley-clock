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
//I2C_BCK         D19

//SD_3V3          3V3
//SD_CS           D15
//SD_MOSI         D26
//SD_CLK          D25
//SD_MISO         D33
//SD_GND          GND

//servo_brown     GND
//servo_red       external 5V
//servo_orange1   D5
//servo_orange2   D21
//servo_orange3   D22
//servo_orange4   D32

#include <FS.h>
#include <SD.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <TJpg_Decoder.h>
#include <Audio.h>
#include <ESP32Servo.h>

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

#define STACK_SIZE  4096

SPIClass SD_SPI(HSPI);

TFT_eSPI tft = TFT_eSPI();

Audio audio;

uint8_t currentTargetCS = TFT_CS1;
uint8_t displays[] = {TFT_CS1, TFT_CS2, TFT_CS3, TFT_CS4};

Servo servoMotor1;
Servo servoMotor2;
Servo servoMotor3;
Servo servoMotor4;

int centerServoAngle = map(0, -60, 60, 0, 180);
int rightServoAngle = map(30, -60, 60, 0, 180);
int leftServoAngle = map(-30, -60, 60, 0, 180);

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

void displays_and_servos(void* params) {
  while(true) {
    Serial.println("Henesys -> 1, Ellinia -> 2, Kerning -> 3, Perion -> 4");
  
    targetDisplay(TFT_CS1);
    TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SD);

    targetDisplay(TFT_CS2);
    TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SD);

    targetDisplay(TFT_CS3);
    TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SD);

    targetDisplay(TFT_CS4);
    TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SD);

    Serial.println("right -> 1");
    servoMotor1.write(rightServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("center -> 1");
    servoMotor1.write(centerServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("left -> 1");
    servoMotor1.write(leftServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("center -> 1");
    servoMotor1.write(centerServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));

    Serial.println("Ellinia -> 1, Kerning -> 2, Perion -> 3, Henesys -> 4");
    
    targetDisplay(TFT_CS1);
    TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SD);

    targetDisplay(TFT_CS2);
    TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SD);

    targetDisplay(TFT_CS3);
    TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SD);

    targetDisplay(TFT_CS4);
    TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SD);

    Serial.println("right -> 2");
    servoMotor2.write(rightServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("center -> 2");
    servoMotor2.write(centerServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("left -> 2");
    servoMotor2.write(leftServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("center -> 2");
    servoMotor2.write(centerServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));

    Serial.println("Kerning -> 1, Perion -> 2, Henesys -> 3, Ellinia -> 4");
    
    targetDisplay(TFT_CS1);
    TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SD);

    targetDisplay(TFT_CS2);
    TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SD);

    targetDisplay(TFT_CS3);
    TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SD);

    targetDisplay(TFT_CS4);
    TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SD);

    Serial.println("right -> 3");
    servoMotor3.write(rightServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("center -> 3");
    servoMotor3.write(centerServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("left -> 3");
    servoMotor3.write(leftServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("center -> 3");
    servoMotor3.write(centerServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));

    Serial.println("Perion -> 1, Henesys -> 2, Ellinia -> 3, Kerning -> 4");
    
    targetDisplay(TFT_CS1);
    TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SD);

    targetDisplay(TFT_CS2);
    TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SD);

    targetDisplay(TFT_CS3);
    TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SD);

    targetDisplay(TFT_CS4);
    TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SD);

    Serial.println("right -> 4");
    servoMotor4.write(rightServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("center -> 4");
    servoMotor4.write(centerServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("left -> 4");
    servoMotor4.write(leftServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.println("center -> 4");
    servoMotor4.write(centerServoAngle);
    vTaskDelay(pdMS_TO_TICKS(500));
  }
}

void setup() {
  Serial.begin(115200);

  servoMotor1.attach(servo_PWM1);
  servoMotor2.attach(servo_PWM2);
  servoMotor3.attach(servo_PWM3);
  servoMotor4.attach(servo_PWM4);

  servoMotor1.write(centerServoAngle);
  delay(500);
  servoMotor2.write(centerServoAngle);
  delay(500);
  servoMotor3.write(centerServoAngle);
  delay(500);
  servoMotor4.write(centerServoAngle);
  delay(500);
  Serial.println("Servos are set");

  SD_SPI.begin(SD_CLK, SD_MISO, SD_MOSI, SD_CS);

  if (!SD.begin(SD_CS, SD_SPI)) {
    Serial.println("SD Card mounted failed");
    return;
  }
  Serial.println("SD Card mounted successfully");

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

  Serial.println("Displays are set");

  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(10);
  audio.connecttoFS(SD, "/Title.mp3");
  audio.setFileLoop(true);

  Serial.println("Audio are set");

  xTaskCreatePinnedToCore(displays_and_servos, "displays_and_servos", STACK_SIZE, nullptr, 5, nullptr, 0);
}

void loop() {
  audio.loop();
}
