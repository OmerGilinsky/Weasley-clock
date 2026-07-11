//SD_3V3    3V3
//SD_CS     D5
//SD_MOSI   D23
//SD_CLK    D18
//SD_MISO   D19
//SD_GND    GND

#include <FS.h>
#include <SD.h>
#include <SPI.h>

#define SD_CLK  25
#define SD_MISO 33
#define SD_MOSI 26
#define SD_CS   15

SPIClass SD_SPI(HSPI);

void setup() {
  Serial.begin(115200);
  
  SD_SPI.begin(SD_CLK, SD_MISO, SD_MOSI, SD_CS);

  if (!SD.begin(SD_CS, SD_SPI)) {
    Serial.println("SD Card mounted failed");
    return;
  }
  Serial.println("SD Card mounted successfully");
}

void loop() {}
