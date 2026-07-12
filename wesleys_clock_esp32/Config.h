#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// ==========================================
// 1. WiFi Credentials
// ==========================================
#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// ==========================================
// 2. Firebase Credentials & Configuration
// ==========================================
#define API_KEY "AIzaSyAFCIatremITVZz1iRzOEpH7gUicLCJ8Iw"
#define PROJECT_ID "wesleys-clock"
#define USER_EMAIL "esp32-wesleys@clock.com"
#define USER_PASSWORD "123456"

// ==========================================
// 3. Servo Motors (MG995) Configuration
// ==========================================
#define NUM_SERVOS 4
const int SERVO_PINS[NUM_SERVOS] = {13, 12, 14, 27}; // GPIOs for Hand 1, 2, 3, 4

// ==========================================
// 4. SPI Bus Pins (Shared by SD Card and TFTs)
// ==========================================
#define SPI_SCK  18
#define SPI_MISO 19
#define SPI_MOSI 23

// ==========================================
// 5. SD Card Configuration
// ==========================================
#define SD_CS_PIN 5 // Chip Select for SD Card

// ==========================================
// 6. TFT LCD Display Configuration (4 Screens)
// ==========================================
#define NUM_SCREENS 4
const int TFT_CS_PINS[NUM_SCREENS] = {15, 16, 17, 4}; // CS pins for Screen 1, 2, 3, 4
#define TFT_DC_PIN  2  // Data/Command pin (shared)
#define TFT_RST_PIN 0  // Reset pin (shared, or -1 if connected to ESP32 EN/RST)

// ==========================================
// 7. I2S Audio DAC (PCM5102A) Configuration
// ==========================================
#define I2S_BCLK_PIN 26 // Bit Clock
#define I2S_LRC_PIN  25 // Word Select (Left/Right Clock)
#define I2S_DOUT_PIN 22 // Data Out (DIN on DAC)

#endif // CONFIG_H
