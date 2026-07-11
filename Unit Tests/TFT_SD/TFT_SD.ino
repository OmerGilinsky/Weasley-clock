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

//SD_3V3    3V3
//SD_CS     D15
//SD_MOSI   D26
//SD_CLK    D25
//SD_MISO   D33
//SD_GND    GND

#include <FS.h>
#include <SD.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <TJpg_Decoder.h>

#define TFT_CS1   13
#define TFT_CS2   12
#define TFT_CS3   14
#define TFT_CS4   27

#define SD_CLK    25
#define SD_MISO   33
#define SD_MOSI   26
#define SD_CS     15

SPIClass SD_SPI(HSPI);

TFT_eSPI tft = TFT_eSPI();

uint8_t currentTargetCS = TFT_CS1;
uint8_t displays[] = {TFT_CS1, TFT_CS2, TFT_CS3, TFT_CS4};

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
}

void loop() {
  Serial.println("Henesys -> 1, Ellinia -> 2, Kerning -> 3, Perion -> 4");
  
  targetDisplay(TFT_CS1);
  TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SD);

  targetDisplay(TFT_CS2);
  TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SD);

  targetDisplay(TFT_CS3);
  TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SD);

  targetDisplay(TFT_CS4);
  TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SD);

  delay(2500);

  Serial.println("Ellinia -> 1, Kerning -> 2, Perion -> 3, Henesys -> 4");
  
  targetDisplay(TFT_CS1);
  TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SD);

  targetDisplay(TFT_CS2);
  TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SD);

  targetDisplay(TFT_CS3);
  TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SD);

  targetDisplay(TFT_CS4);
  TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SD);

  delay(2500);

  Serial.println("Kerning -> 1, Perion -> 2, Henesys -> 3, Ellinia -> 4");
  
  targetDisplay(TFT_CS1);
  TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SD);

  targetDisplay(TFT_CS2);
  TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SD);

  targetDisplay(TFT_CS3);
  TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SD);

  targetDisplay(TFT_CS4);
  TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SD);

  delay(2500);

  Serial.println("Perion -> 1, Henesys -> 2, Ellinia -> 3, Kerning -> 4");
  
  targetDisplay(TFT_CS1);
  TJpgDec.drawFsJpg(0, 0, "/Ellinia.jpg", SD);

  targetDisplay(TFT_CS2);
  TJpgDec.drawFsJpg(0, 0, "/Kerning.jpg", SD);

  targetDisplay(TFT_CS3);
  TJpgDec.drawFsJpg(0, 0, "/Perion.jpg", SD);

  targetDisplay(TFT_CS4);
  TJpgDec.drawFsJpg(0, 0, "/Henesys.jpg", SD);

  delay(2500);
}
