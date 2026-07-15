#include "AudioSD.h"
#include "Config.h"
#include <SPI.h>
#include <FS.h>
#include <SD.h>
#include "Audio.h"

// External declarations for audio queue
struct AudioMessage {
    char filePath[128];
};
extern QueueHandle_t audioQueue;

// Audio object from ESP32-audioI2S library
Audio audio;

void initAudioSD() {
    Serial.println("[AudioSD] Initializing SPI and SD Card...");
    
    // SPI.begin(SCK, MISO, MOSI, SS)
    // We pass -1 or SD_CS_PIN for the SS pin, and begin SD Card
    SPI.begin(SPI_SCK, SPI_MISO, SPI_MOSI);
    
    if (!SD.begin(SD_CS_PIN)) {
        Serial.println("[AudioSD] ERROR: SD Card Mount Failed!");
    } else {
        Serial.println("[AudioSD] SD Card Mount Successful.");
        
        // Ensure directories exist
        if (!SD.exists("/audio")) {
            SD.mkdir("/audio");
        }
        if (!SD.exists("/audio/users")) {
            SD.mkdir("/audio/users");
        }
        if (!SD.exists("/audio/locations")) {
            SD.mkdir("/audio/locations");
        }
    }

    Serial.println("[AudioSD] Initializing I2S DAC...");
    // Connect PCM5102A: BCLK, LRC (LCLK/WCLK), DIN (DOUT)
    audio.setPinout(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN);
    audio.setVolume(18); // Volume range 0 to 21 (18 is comfortable and loud enough)
}

void TaskAudio(void *pvParameters) {
    (void)pvParameters;
    
    initAudioSD();
    
    AudioMessage currentMsg;
    bool isPlaying = false;
    
    for (;;) {
        // If not currently playing, check for a new file in the queue
        if (!audio.isRunning()) {
            // Check if we just stopped playing a temporary voice message and need to delete it
            if (isPlaying) {
                Serial.printf("[AudioTask] Finished playing: %s\n", currentMsg.filePath);
                
                if (strcmp(currentMsg.filePath, "/audio/temp_msg.mp3") == 0) {
                    Serial.println("[AudioTask] Deleting temporary voice message file from SD...");
                    SD.remove("/audio/temp_msg.mp3");
                }
                
                isPlaying = false;
            }

            // Look for a new audio announcement
            if (xQueueReceive(audioQueue, &currentMsg, pdMS_TO_TICKS(50)) == pdTRUE) {
                if (SD.exists(currentMsg.filePath)) {
                    Serial.printf("[AudioTask] Starting playback of: %s\n", currentMsg.filePath);
                    audio.connecttoFS(SD, currentMsg.filePath);
                    isPlaying = true;
                } else {
                    Serial.printf("[AudioTask] Warning: Requested audio file not found on SD: %s\n", currentMsg.filePath);
                }
            }
        }

        // Feed the I2S buffers (must be called continuously)
        audio.loop();

        // Yield to prevent watchdog reset, keeping delay minimal for smooth audio stream
        vTaskDelay(pdMS_TO_TICKS(1));
    }
}
