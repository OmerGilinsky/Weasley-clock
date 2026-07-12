#ifndef FIREBASE_CLOUD_H
#define FIREBASE_CLOUD_H

#include <Arduino.h>

// Initialize Wifi and Firebase
void initFirebase();

// Task function for FreeRTOS
void TaskFirebase(void *pvParameters);

// Helper to download files to SD card
bool downloadFileToSD(String fileUrl, const char* localPath);

#endif // FIREBASE_CLOUD_H
