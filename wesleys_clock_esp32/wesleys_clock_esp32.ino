#include "Config.h"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>

// Shared User state struct
struct UserClockState {
    char fullName[64];
    int handNumber; // 1 to 4
    int targetAngle;
    int currentAngle;
    char currentLocation[64];
    bool locationChanged; // Flag to trigger audio/display updates
    char displayGreetingUrl[256]; // URL for custom drawings/doodles
    bool greetingChanged; // Flag to trigger display redraws for doodles
};

// Global shared variables
UserClockState clockUsers[NUM_SERVOS];
SemaphoreHandle_t stateMutex = NULL;

// Audio Queue
QueueHandle_t audioQueue = NULL;
struct AudioMessage {
    char filePath[128];
};

// Task Handles
TaskHandle_t tFirebase = NULL;
TaskHandle_t tMotors = NULL;
TaskHandle_t tAudio = NULL;
TaskHandle_t tDisplay = NULL;

// Forward declarations of task functions
void TaskFirebase(void *pvParameters);
void TaskMotors(void *pvParameters);
void TaskAudio(void *pvParameters);
void TaskDisplay(void *pvParameters);

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("=========================================");
    Serial.println("   Wesley's Clock ESP32 Firmware Booting ");
    Serial.println("=========================================");

    // 1. Create Mutex for shared state protection
    stateMutex = xSemaphoreCreateMutex();
    if (stateMutex == NULL) {
        Serial.println("Critical Error: Failed to create State Mutex!");
        while (1) delay(1000);
    }

    // 2. Create Queue for Audio files
    audioQueue = xQueueCreate(10, sizeof(AudioMessage));
    if (audioQueue == NULL) {
        Serial.println("Critical Error: Failed to create Audio Queue!");
        while (1) delay(1000);
    }

    // Initialize state structure
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    for (int i = 0; i < NUM_SERVOS; i++) {
        snprintf(clockUsers[i].fullName, sizeof(clockUsers[i].fullName), "Unassigned");
        clockUsers[i].handNumber = i + 1;
        clockUsers[i].targetAngle = 0;
        clockUsers[i].currentAngle = 0;
        snprintf(clockUsers[i].currentLocation, sizeof(clockUsers[i].currentLocation), "Unknown");
        clockUsers[i].locationChanged = false;
        clockUsers[i].displayGreetingUrl[0] = '\0';
        clockUsers[i].greetingChanged = false;
    }
    xSemaphoreGive(stateMutex);

    // 3. Create FreeRTOS Tasks
    // Firebase Task (High memory stack for Network client)
    xTaskCreatePinnedToCore(
        TaskFirebase,
        "FirebaseTask",
        8192,
        NULL,
        1,              // Priority
        &tFirebase,
        0               // Core 0 (Network stack)
    );

    // Motors Task (Time critical for PWM signals, smaller stack)
    xTaskCreatePinnedToCore(
        TaskMotors,
        "MotorsTask",
        4096,
        NULL,
        2,              // Higher Priority for smooth stepping
        &tMotors,
        1               // Core 1 (Peripherals and control loop)
    );

    // Audio Task (Needs constant streaming, high priority on core 1)
    xTaskCreatePinnedToCore(
        TaskAudio,
        "AudioTask",
        8192,
        NULL,
        3,              // High Priority to avoid stuttering
        &tAudio,
        1               // Core 1
    );

    // Display Task (Lower priority graphical updates)
    xTaskCreatePinnedToCore(
        TaskDisplay,
        "DisplayTask",
        8192,
        NULL,
        1,              // Priority
        &tDisplay,
        1               // Core 1
    );

    Serial.println("System Tasks Scheduled Successfully!");
}

void loop() {
    // Under FreeRTOS, the Arduino loop() task runs at low priority.
    // We can keep it empty or perform basic system health monitoring here.
    vTaskDelay(pdMS_TO_TICKS(1000));
}
