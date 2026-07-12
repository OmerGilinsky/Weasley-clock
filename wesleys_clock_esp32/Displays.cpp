#include "Displays.h"
#include "Config.h"
#include <SPI.h>
#include <FS.h>
#include <SD.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>

// External state declarations from main sketch
struct UserClockState {
    char fullName[64];
    int handNumber;
    int targetAngle;
    int currentAngle;
    char currentLocation[64];
    bool locationChanged;
    char displayGreetingUrl[256];
    bool greetingChanged;
};
extern UserClockState clockUsers[NUM_SERVOS];
extern SemaphoreHandle_t stateMutex;

// Construct Adafruit ST7789 instance without hardcoded CS (CS pin passed as -1)
Adafruit_ST7789 tft = Adafruit_ST7789(-1, TFT_DC_PIN, TFT_RST_PIN);

// Forward declarations of internal helpers
void drawBMP(const char *filename, int x, int y);
uint16_t read16(File &f);
uint32_t read32(File &f);

int getScreenIndexFromAngle(int angle) {
    if (angle <= 180) {
        // Standard 180-degree sweep servos mapped to 4 sectors
        if (angle < 45) return 0;
        else if (angle < 90) return 1;
        else if (angle < 135) return 2;
        else return 3;
    } else {
        // Continuous rotation / 360-degree sweep servos mapped to 4 sectors
        if (angle < 90) return 0;
        else if (angle < 180) return 1;
        else if (angle < 270) return 2;
        else return 3;
    }
}

void initDisplays() {
    Serial.println("[Displays] Configuring Chip Select pins...");
    
    // Configure and disable all screen CS pins (set HIGH)
    for (int i = 0; i < NUM_SCREENS; i++) {
        pinMode(TFT_CS_PINS[i], OUTPUT);
        digitalWrite(TFT_CS_PINS[i], HIGH);
    }
    
    // Initialize the shared SPI bus and screen controllers
    // Select screen 1 to start the physical display controller init sequence
    digitalWrite(TFT_CS_PINS[0], LOW);
    tft.init(240, 280); // Width 240, Height 280
    tft.setRotation(0);
    tft.fillScreen(ST77XX_BLACK);
    digitalWrite(TFT_CS_PINS[0], HIGH);
    
    // Configure all remaining screens (no need to call tft.init again, just draw)
    for (int i = 0; i < NUM_SCREENS; i++) {
        digitalWrite(TFT_CS_PINS[i], LOW);
        tft.fillScreen(ST77XX_BLACK);
        
        // Draw splash text
        tft.setTextColor(ST77XX_WHITE);
        tft.setTextSize(2);
        tft.setCursor(20, 100);
        tft.printf("Wesley's Clock\n\n  Screen %d Ready", i + 1);
        
        // Draw boundaries
        tft.drawRect(0, 0, 240, 280, ST77XX_CYAN);
        
        digitalWrite(TFT_CS_PINS[i], HIGH);
    }
    
    Serial.println("[Displays] Multi-screen initialization complete.");
}

void TaskDisplay(void *pvParameters) {
    (void)pvParameters;
    
    // Init Displays
    initDisplays();
    
    for (;;) {
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        for (int i = 0; i < NUM_SERVOS; i++) {
            // 1. Process Location Updates
            if (clockUsers[i].locationChanged) {
                clockUsers[i].locationChanged = false;
                
                int currentAngle = clockUsers[i].currentAngle;
                char locName[64];
                strncpy(locName, clockUsers[i].currentLocation, sizeof(locName));
                char userName[64];
                strncpy(userName, clockUsers[i].fullName, sizeof(userName));
                
                xSemaphoreGive(stateMutex);
                
                int screenIdx = getScreenIndexFromAngle(currentAngle);
                
                Serial.printf("[DisplayTask] Updating Screen %d with location: %s\n", screenIdx + 1, locName);
                
                digitalWrite(TFT_CS_PINS[screenIdx], LOW);
                tft.fillScreen(ST77XX_BLACK);
                
                char bmpPath[128];
                snprintf(bmpPath, sizeof(bmpPath), "/images/%s.bmp", locName);
                
                if (SD.exists(bmpPath)) {
                    drawBMP(bmpPath, 0, 0);
                } else {
                    tft.drawRect(0, 0, 240, 280, ST77XX_YELLOW);
                    tft.setTextColor(ST77XX_YELLOW);
                    tft.setTextSize(3);
                    tft.setCursor(20, 100);
                    tft.println(locName);
                }
                
                tft.fillRect(0, 240, 240, 40, ST77XX_BLACK);
                tft.drawFastHLine(0, 240, 240, ST77XX_CYAN);
                tft.setTextColor(ST77XX_CYAN);
                tft.setTextSize(2);
                tft.setCursor(10, 252);
                tft.printf("%s arrived!", userName);
                
                digitalWrite(TFT_CS_PINS[screenIdx], HIGH);
                
                xSemaphoreTake(stateMutex, portMAX_DELAY);
            }

            // 2. Process Doodle / Visual Greeting Updates
            if (clockUsers[i].greetingChanged) {
                clockUsers[i].greetingChanged = false;
                
                int currentAngle = clockUsers[i].currentAngle;
                char locName[64];
                strncpy(locName, clockUsers[i].currentLocation, sizeof(locName));
                char userName[64];
                strncpy(userName, clockUsers[i].fullName, sizeof(userName));
                char greetingUrl[256];
                strncpy(greetingUrl, clockUsers[i].displayGreetingUrl, sizeof(greetingUrl));
                int handNum = clockUsers[i].handNumber;
                
                xSemaphoreGive(stateMutex);
                
                int screenIdx = getScreenIndexFromAngle(currentAngle);
                
                digitalWrite(TFT_CS_PINS[screenIdx], LOW);
                tft.fillScreen(ST77XX_BLACK);
                
                if (strlen(greetingUrl) > 0) {
                    // Render doodle image
                    char greetingPath[64];
                    snprintf(greetingPath, sizeof(greetingPath), "/images/greetings/hand%d.bmp", handNum);
                    
                    Serial.printf("[DisplayTask] Rendering doodle on Screen %d: %s\n", screenIdx + 1, greetingPath);
                    if (SD.exists(greetingPath)) {
                        drawBMP(greetingPath, 0, 0);
                    } else {
                        tft.drawRect(0, 0, 240, 280, ST77XX_MAGENTA);
                        tft.setTextColor(ST77XX_MAGENTA);
                        tft.setTextSize(2);
                        tft.setCursor(20, 100);
                        tft.println("New Doodle!");
                    }
                    
                    tft.fillRect(0, 240, 240, 40, ST77XX_BLACK);
                    tft.drawFastHLine(0, 240, 240, ST77XX_MAGENTA);
                    tft.setTextColor(ST77XX_MAGENTA);
                    tft.setTextSize(2);
                    tft.setCursor(10, 252);
                    tft.printf("Doodle for %s", userName);
                } else {
                    // Restore original location screen background
                    Serial.printf("[DisplayTask] Doodle cleared. Restoring Screen %d location: %s\n", screenIdx + 1, locName);
                    char bmpPath[128];
                    snprintf(bmpPath, sizeof(bmpPath), "/images/%s.bmp", locName);
                    
                    if (SD.exists(bmpPath)) {
                        drawBMP(bmpPath, 0, 0);
                    } else {
                        tft.drawRect(0, 0, 240, 280, ST77XX_YELLOW);
                        tft.setTextColor(ST77XX_YELLOW);
                        tft.setTextSize(3);
                        tft.setCursor(20, 100);
                        tft.println(locName);
                    }
                    
                    tft.fillRect(0, 240, 240, 40, ST77XX_BLACK);
                    tft.drawFastHLine(0, 240, 240, ST77XX_CYAN);
                    tft.setTextColor(ST77XX_CYAN);
                    tft.setTextSize(2);
                    tft.setCursor(10, 252);
                    tft.printf("%s is here", userName);
                }
                
                digitalWrite(TFT_CS_PINS[screenIdx], HIGH);
                
                xSemaphoreTake(stateMutex, portMAX_DELAY);
            }
        }
        xSemaphoreGive(stateMutex);
        
        vTaskDelay(pdMS_TO_TICKS(100)); // Process screen update events
    }
}

// 16-bit reader from file
uint16_t read16(File &f) {
    uint16_t result;
    f.read((uint8_t *)&result, sizeof(result));
    return result;
}

// 32-bit reader from file
uint32_t read32(File &f) {
    uint32_t result;
    f.read((uint8_t *)&result, sizeof(result));
    return result;
}

// Memory-efficient 24-bit BMP renderer
void drawBMP(const char *filename, int x, int y) {
    File bmpFile = SD.open(filename);
    if (!bmpFile) {
        Serial.printf("[TFT] Error: BMP file not found: %s\n", filename);
        return;
    }

    // BMP signature verification ("BM")
    if (read16(bmpFile) != 0x4D42) {
        Serial.println("[TFT] Error: Invalid BMP signature.");
        bmpFile.close();
        return;
    }

    read32(bmpFile); // Read file size
    read32(bmpFile); // Read creator bytes
    uint32_t imageOffset = read32(bmpFile); // Offset to starting pixel data
    read32(bmpFile); // Read header size
    int32_t width = read32(bmpFile);
    int32_t height = read32(bmpFile);
    uint16_t planes = read16(bmpFile);
    uint16_t depth = read16(bmpFile);
    uint32_t compression = read32(bmpFile);

    // Support only standard uncompressed 24-bit BMP images
    if (depth != 24 || compression != 0) {
        Serial.println("[TFT] Error: Only 24-bit uncompressed BMP images supported.");
        bmpFile.close();
        return;
    }

    // BMP rows are padded to multiple of 4 bytes
    int rowSize = (width * 3 + 3) & ~3;
    bool flip = true;
    
    // Bottom-up vs top-down BMP check
    if (height < 0) {
        height = -height;
        flip = false;
    }

    int w = width;
    int h = height;

    // Crop to screen boundaries
    if ((x + w - 1) >= 240) w = 240 - x;
    if ((y + h - 1) >= 280) h = 280 - y;

    tft.startWrite();
    tft.setAddrWindow(x, y, w, h);

    uint8_t sdbuffer[3 * 20]; // Buffer for 20 pixels
    int buffidx = sizeof(sdbuffer);

    for (int row = 0; row < h; row++) {
        uint32_t pos;
        if (flip) {
            pos = imageOffset + (height - 1 - row) * rowSize;
        } else {
            pos = imageOffset + row * rowSize;
        }

        if (bmpFile.position() != pos) {
            tft.endWrite();
            bmpFile.seek(pos);
            tft.startWrite();
        }

        for (int col = 0; col < w; col++) {
            // Read next chunk of pixels
            if (buffidx >= sizeof(sdbuffer)) {
                tft.endWrite();
                bmpFile.read(sdbuffer, sizeof(sdbuffer));
                tft.startWrite();
                buffidx = 0;
            }

            // Convert BGR to RGB565
            uint8_t b = sdbuffer[buffidx++];
            uint8_t g = sdbuffer[buffidx++];
            uint8_t r = sdbuffer[buffidx++];
            uint16_t color = tft.color565(r, g, b);
            tft.writePixel(color);
        }
    }
    tft.endWrite();
    bmpFile.close();
}
