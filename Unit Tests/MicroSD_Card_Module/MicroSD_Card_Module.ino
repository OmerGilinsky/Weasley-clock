//TFT_GND   GND
//TFT_VCC   3V3
//TFT_SCL   D18
//TFT_SDA   D23
//TFT_RES   D4
//TFT_DC    D2
//TFT_CS1   D15
//TFT_CS2   D14
//TFT_CS3   D12
//TFT_CS4   D13
//TFT_BLK   3V3

//I2S_VIN   3V3
//I2C_GND   GND
//I2C_LCK   D27
//I2C_DIN   D26
//I2C_BCK   D25

//SD_3V3    3V3
//SD_CS     D5
//SD_MOSI   D23
//SD_CLK    D18
//SD_MISO   D19
//SD_GND    GND

#include <TFT_eSPI.h>
#include <TJpg_Decoder.h>

#include "Audio.h"
#include "FS.h"

#include "SD.h"

#define CS_DISP1  15
#define CS_DISP2  14
#define CS_DISP3  12
#define CS_DISP4  13

#define I2S_DOUT  26
#define I2S_BCLK  25
#define I2S_LRC   27

#define SD_CS     5

TFT_eSPI tft = TFT_eSPI();

Audio audio;

uint8_t currentTargetCS = CS_DISP1;

unsigned long lastDisplaySwitch = 0;
uint8_t currentFrameIndex = 0;

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

void setup() {
  
  Serial.begin(115200);

  pinMode(CS_DISP1, OUTPUT);
  pinMode(CS_DISP2, OUTPUT);
  pinMode(CS_DISP3, OUTPUT);
  pinMode(CS_DISP4, OUTPUT);
  pinMode(SD_CS, OUTPUT);

  digitalWrite(CS_DISP1, HIGH);
  digitalWrite(CS_DISP2, HIGH);
  digitalWrite(CS_DISP3, HIGH);
  digitalWrite(CS_DISP4, HIGH);
  digitalWrite(SD_CS, HIGH);

  if (!SD.begin(SD_CS)) {
    Serial.println("An Error has occurred while mounting SD Card");
    return;
  }
  Serial.println("SD Card mounted successfully.");

  digitalWrite(CS_DISP1, LOW);
  digitalWrite(CS_DISP2, LOW);
  digitalWrite(CS_DISP3, LOW);
  digitalWrite(CS_DISP4, LOW);

  tft.init();
  tft.setRotation(0);

  digitalWrite(CS_DISP1, HIGH);
  digitalWrite(CS_DISP2, HIGH);
  digitalWrite(CS_DISP3, HIGH);
  digitalWrite(CS_DISP4, HIGH);

  uint8_t screens[] = {CS_DISP1, CS_DISP2, CS_DISP3, CS_DISP4};
  for (int i = 0; i < 4; i++) {
    digitalWrite(screens[i], LOW);
    tft.fillScreen(TFT_BLACK);
    digitalWrite(screens[i], HIGH);
  }

  TJpgDec.setSwapBytes(true);
  TJpgDec.setCallback(tft_output);

  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
  audio.setVolume(10);
  audio.connecttoFS(SD, "/MapleStory_sounds/Logo.wav");
  audio.setFileLoop(true);

  delay(5000);
}

void loop() {
  audio.loop();

  if (millis() - lastDisplaySwitch >= 1000) {

    lastDisplaySwitch = millis(); 

    switch (currentFrameIndex) {

      case 0:
        targetDisplay(CS_DISP1); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Henesys.jpg", SD);
        currentFrameIndex = 1;
        break;
      case 1:
        targetDisplay(CS_DISP2); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Ellinia.jpg", SD);
        currentFrameIndex = 2;
        break;
      case 2:
        targetDisplay(CS_DISP3); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Kerning City.jpg", SD);
        currentFrameIndex = 3;
        break;
      case 3:
        targetDisplay(CS_DISP4); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Perion.jpg", SD);
        currentFrameIndex = 4;
        break;

      case 4:
        targetDisplay(CS_DISP1); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Ellinia.jpg", SD);
        currentFrameIndex = 5;
        break;
      case 5:
        targetDisplay(CS_DISP2); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Kerning City.jpg", SD);
        currentFrameIndex = 6;
        break;
      case 6:
        targetDisplay(CS_DISP3); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Perion.jpg", SD);
        currentFrameIndex = 7;
        break;
      case 7:
        targetDisplay(CS_DISP4); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Henesys.jpg", SD);
        currentFrameIndex = 8;
        break;

      case 8:
        targetDisplay(CS_DISP1); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Kerning City.jpg", SD);
        currentFrameIndex = 9;
        break;
      case 9:
        targetDisplay(CS_DISP2); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Perion.jpg", SD);
        currentFrameIndex = 10;
        break;
      case 10:
        targetDisplay(CS_DISP3); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Henesys.jpg", SD);
        currentFrameIndex = 11;
        break;
      case 11:
        targetDisplay(CS_DISP4); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Ellinia.jpg", SD);
        currentFrameIndex = 12;
        break;

      case 12:
        targetDisplay(CS_DISP1); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Perion.jpg", SD);
        currentFrameIndex = 13;
        break;
      case 13:
        targetDisplay(CS_DISP2); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Henesys.jpg", SD);
        currentFrameIndex = 14;
        break;
      case 14:
        targetDisplay(CS_DISP3); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Ellinia.jpg", SD);
        currentFrameIndex = 15;
        break;
      case 15:
        targetDisplay(CS_DISP4); TJpgDec.drawFsJpg(0, 0, "/MapleStory_icons/Kerning City.jpg", SD);
        currentFrameIndex = 0;
        break;
    }
  }
}
