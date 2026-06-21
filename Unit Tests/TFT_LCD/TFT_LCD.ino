//GND   GND
//VCC   3V3
//SCL   D18
//SDA   D23
//RES   D4
//DC    D2
//CS    D13,D12,D14,D27
//BLK   3V3

#include <FS.h>
#include "SPIFFS.h"
#include <TFT_eSPI.h>
#include <TJpg_Decoder.h>

#define CS_DISP1 13
#define CS_DISP2 12
#define CS_DISP3 14
#define CS_DISP4 27

TFT_eSPI tft = TFT_eSPI();

// Global variable to keep track of which screen should actively receive pixels
uint8_t currentTargetCS = CS_DISP1;

//The decoder calls this function repeatedly for small pixel blocks
bool tft_output(int16_t x, int16_t y, uint16_t w, uint16_t h, uint16_t* bitmap) {
  if (y >= tft.height()) return 0;
  
  // Manually pull the target display's CS LOW right before pushing the block
  digitalWrite(currentTargetCS, LOW);
  
  // Push the pixel block to the screen
  tft.pushImage(x, y, w, h, bitmap);
  
  // Immediately pull it HIGH again so the SPI bus is free for SPIFFS reading
  digitalWrite(currentTargetCS, HIGH);
  
  return 1;
}

// Simplified selector function that sets our tracking target
void targetDisplay(uint8_t targetCsPin) {
  currentTargetCS = targetCsPin;
}

void setup() {
  Serial.begin(115200);

  // Configure all CS pins as outputs
  pinMode(CS_DISP1, OUTPUT);
  pinMode(CS_DISP2, OUTPUT);
  pinMode(CS_DISP3, OUTPUT);
  pinMode(CS_DISP4, OUTPUT);
  
  // Set all CS pins HIGH (disabled) initially
  digitalWrite(CS_DISP1, HIGH);
  digitalWrite(CS_DISP2, HIGH);
  digitalWrite(CS_DISP3, HIGH);
  digitalWrite(CS_DISP4, HIGH);
  
  if (!SPIFFS.begin(true)) {
    Serial.println("SPIFFS Mount Failed");
    return;
  }

  // To initialize the driver chips, pull ALL CS pins LOW simultaneously 
  // so the startup commands reach all 4 connected displays
  digitalWrite(CS_DISP1, LOW);
  digitalWrite(CS_DISP2, LOW);
  digitalWrite(CS_DISP3, LOW);
  digitalWrite(CS_DISP4, LOW);
  
  tft.init();
  tft.setRotation(0);
  
  // Turn all CS lines back HIGH immediately after initialization
  digitalWrite(CS_DISP1, HIGH);
  digitalWrite(CS_DISP2, HIGH);
  digitalWrite(CS_DISP3, HIGH);
  digitalWrite(CS_DISP4, HIGH);

  // Clear all screens to black individually using our manual helper
  uint8_t screens[] = {CS_DISP1, CS_DISP2, CS_DISP3, CS_DISP4};
  for (int i = 0; i < 4; i++) {
    digitalWrite(screens[i], LOW);
    tft.fillScreen(TFT_BLACK);
    digitalWrite(screens[i], HIGH);
  }

  TJpgDec.setSwapBytes(true);
  TJpgDec.setCallback(tft_output);
}

void loop() {
  // --- FRAME 1 ---
  Serial.println("Henesys -> 1, Ellinia -> 2, Kerning -> 3, Perion -> 4");
  
  targetDisplay(CS_DISP1);
  TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SPIFFS);

  targetDisplay(CS_DISP2);
  TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SPIFFS);

  targetDisplay(CS_DISP3);
  TJpgDec.drawFsJpg(0, 0, "/Kerning City.jpg", SPIFFS);

  targetDisplay(CS_DISP4);
  TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SPIFFS);

  delay(2500);

  // --- FRAME 2 ---
  Serial.println("Ellinia -> 1, Kerning -> 2, Perion -> 3, Henesys -> 4");
  
  targetDisplay(CS_DISP1);
  TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SPIFFS);

  targetDisplay(CS_DISP2);
  TJpgDec.drawFsJpg(0, 0, "/Kerning City.jpg", SPIFFS);

  targetDisplay(CS_DISP3);
  TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SPIFFS);

  targetDisplay(CS_DISP4);
  TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SPIFFS);

  delay(2500);

  // --- FRAME 3 ---
  Serial.println("Kerning -> 1, Perion -> 2, Henesys -> 3, Ellinia -> 4");
  
  targetDisplay(CS_DISP1);
  TJpgDec.drawFsJpg(0, 0, "/Kerning City.jpg", SPIFFS);

  targetDisplay(CS_DISP2);
  TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SPIFFS);

  targetDisplay(CS_DISP3);
  TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SPIFFS);

  targetDisplay(CS_DISP4);
  TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SPIFFS);

  delay(2500);

  // --- FRAME 4 ---
  Serial.println("Perion -> 1, Henesys -> 2, Ellinia -> 3, Kerning -> 4");
  
  targetDisplay(CS_DISP1);
  TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SPIFFS);

  targetDisplay(CS_DISP2);
  TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SPIFFS);

  targetDisplay(CS_DISP3);
  TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SPIFFS);

  targetDisplay(CS_DISP4);
  TJpgDec.drawFsJpg(0, 0, "/Kerning City.jpg", SPIFFS);

  delay(2500);
}