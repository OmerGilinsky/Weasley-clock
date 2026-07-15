#ifndef DISPLAYS_H
#define DISPLAYS_H

#include <Arduino.h>

// Initialize all TFT screens
void initDisplays();

// Task function for FreeRTOS
void TaskDisplay(void *pvParameters);

// Helper to determine screen index from angle
int getScreenIndexFromAngle(int angle);

#endif // DISPLAYS_H
