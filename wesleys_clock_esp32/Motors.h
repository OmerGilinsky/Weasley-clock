#ifndef MOTORS_H
#define MOTORS_H

#include <Arduino.h>

// Initialize Servos
void initMotors();

// Task function for FreeRTOS
void TaskMotors(void *pvParameters);

#endif // MOTORS_H
