//TFT_GND   GND
//TFT_VCC   3V3
//TFT_SCL   D18
//TFT_SDA   D23
//TFT_RES   D4
//TFT_DC    D2
//TFT_CS1   D13
//TFT_CS2   D12
//TFT_CS3   D14
//TFT_CS4   D27
//TFT_BLK   3V3

//I2S_VIN   3V3
//I2C_GND   GND
//I2C_LCK   D26
//I2C_DIN   D25
//I2C_BCK   D33

#include <TFT_eSPI.h>
#include <TJpg_Decoder.h>

#include "Audio.h"
#include "FS.h"

#define CS_DISP1  13
#define CS_DISP2  12
#define CS_DISP3  14
#define CS_DISP4  27

#define I2S_DOUT  25
#define I2S_BCLK  33
#define I2S_LRC   26

#define STACK_SIZE  4096

TFT_eSPI tft = TFT_eSPI();

Audio audio;

uint8_t currentTargetCS = CS_DISP1;

unsigned long lastDisplaySwitch = 0;

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

void display(void* params) {

  uint8_t frame = 0;

  while(true) {
    switch (frame) {
      case 0:
        targetDisplay(CS_DISP1); TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SPIFFS);
        targetDisplay(CS_DISP2); TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SPIFFS);
        targetDisplay(CS_DISP3); TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SPIFFS);
        targetDisplay(CS_DISP4); TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SPIFFS);
        Serial.println("Henesys -> 1, Ellinia -> 2, Kerning -> 3, Perion -> 4");
        frame = 1;
        break;
      case 1:
        targetDisplay(CS_DISP1); TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SPIFFS);*
        targetDisplay(CS_DISP2); TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SPIFFS);
        targetDisplay(CS_DISP3); TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SPIFFS);
        targetDisplay(CS_DISP4); TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SPIFFS);
        Serial.println("Ellinia -> 1, Kerning -> 2, Perion -> 3, Henesys -> 4");
        frame = 2;
        break;
      case 2:
        targetDisplay(CS_DISP1); TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SPIFFS);
        targetDisplay(CS_DISP2); TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SPIFFS);
        targetDisplay(CS_DISP3); TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SPIFFS);
        targetDisplay(CS_DISP4); TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SPIFFS);
        Serial.println("Kerning -> 1, Perion -> 2, Henesys -> 3, Ellinia -> 4");
        frame = 3;
        break;
      case 3:
        targetDisplay(CS_DISP1); TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SPIFFS);
        targetDisplay(CS_DISP2); TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SPIFFS);
        targetDisplay(CS_DISP3); TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SPIFFS);
        targetDisplay(CS_DISP4); TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SPIFFS);
        
        frame = 0;
        break;
    }
    vTaskDelay(pdMS_TO_TICKS(2500));
  }
}

void setup() {
  
  Serial.begin(115200);

  pinMode(CS_DISP1, OUTPUT);
  pinMode(CS_DISP2, OUTPUT);
  pinMode(CS_DISP3, OUTPUT);
  pinMode(CS_DISP4, OUTPUT);

  digitalWrite(CS_DISP1, HIGH);
  digitalWrite(CS_DISP2, HIGH);
  digitalWrite(CS_DISP3, HIGH);
  digitalWrite(CS_DISP4, HIGH);

  if (!SPIFFS.begin(true)) {
    Serial.println("SPIFFS Mount Failed");
    return;
  }

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
  audio.connecttoFS(SPIFFS, "/123_u8.wav");
  audio.setFileLoop(true);

  xTaskCreatePinnedToCore(display, "display", STACK_SIZE, nullptr, 5, nullptr, 0);
}

void loop() {
  audio.loop();
}
