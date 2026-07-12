#include "Motors.h"
#include "Config.h"
#include <ESP32Servo.h>

// External state declarations from main sketch
struct UserClockState {
    char fullName[64];
    int handNumber;
    int targetAngle;
    int currentAngle;
    char currentLocation[64];
    bool locationChanged;
};
extern UserClockState clockUsers[NUM_SERVOS];
extern SemaphoreHandle_t stateMutex;

// Servo objects array
Servo servos[NUM_SERVOS];

void initMotors() {
    Serial.println("[Motors] Initializing Servos...");
    
    // ESP32 requires PWM timer allocations for ESP32Servo library
    ESP32PWM::allocateTimer(0);
    ESP32PWM::allocateTimer(1);
    ESP32PWM::allocateTimer(2);
    ESP32PWM::allocateTimer(3);

    for (int i = 0; i < NUM_SERVOS; i++) {
        servos[i].setPeriodHertz(50); // Standard 50Hz servo signal
        
        // Attach servo pin, specifying standard min/max pulse widths for MG995 (approx 500us to 2400us)
        servos[i].attach(SERVO_PINS[i], 500, 2400); 
        
        // Move to initial home position (0 degrees)
        servos[i].write(0);
        
        Serial.printf("[Motors] Servo %d attached to Pin %d\n", i + 1, SERVO_PINS[i]);
    }
}

void TaskMotors(void *pvParameters) {
    (void)pvParameters;
    
    // Initialize Servos
    initMotors();
    
    const int stepDelayMs = 25; // Delay between degree updates (controls speed)
    const int maxDegreesPerStep = 1; // Degree change per step (controls smoothness)

    for (;;) {
        bool needsMove = false;
        
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        for (int i = 0; i < NUM_SERVOS; i++) {
            // Read target and current angles
            int target = clockUsers[i].targetAngle;
            int current = clockUsers[i].currentAngle;
            
            // Standard MG995 is 180 degrees, clamp target to prevent mechanical strain
            if (target < 0) target = 0;
            if (target > 180) target = 180;

            if (current != target) {
                needsMove = true;
                
                // Calculate next step
                int delta = target - current;
                int step = (delta > 0) ? maxDegreesPerStep : -maxDegreesPerStep;
                
                // Apply step
                current += step;
                
                // Update local state and write to hardware
                clockUsers[i].currentAngle = current;
                servos[i].write(current);
                
                // Print debug info occasionally
                if (current % 10 == 0) {
                    Serial.printf("[Motors] Hand %d (%s) sweeping: %d -> %d\n", 
                                  i + 1, clockUsers[i].fullName, current, target);
                }
            }
        }
        xSemaphoreGive(stateMutex);

        // Slow down movement to make it look smooth and draw less peak current
        vTaskDelay(pdMS_TO_TICKS(stepDelayMs));
    }
}
