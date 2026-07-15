#ifndef AUDIO_SD_H
#define AUDIO_SD_H

#include <Arduino.h>

// Initialize SD card and I2S DAC
void initAudioSD();

// Task function for FreeRTOS
void TaskAudio(void *pvParameters);

#endif // AUDIO_SD_H
