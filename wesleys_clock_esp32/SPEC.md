# Wesley's Clock - ESP32 Firmware Technical Specification

This document details the system design, database schemas, hardware interfaces, and multi-threaded architecture of the physical clock firmware.

---

## 1. Threading Architecture (FreeRTOS Tasks)

The firmware partitions operations across 4 concurrent tasks, leveraging the ESP32's dual-core processor to prevent blocking calls (e.g. WiFi downloads) from interrupting time-critical peripherals (e.g. Servo PWM, Display refresh, Audio stream).

| Task Name | Core | Priority | Stack Size | Description |
| :--- | :---: | :---: | :---: | :--- |
| **`TaskFirebase`** | 0 | 1 | 8 KB | Establishes WiFi connection. Polls Firestore every 5 seconds for user states and new voice messages. Downloads Storage files to the SD card. |
| **`TaskMotors`** | 1 | 2 | 4 KB | Reads user target angles. Steps servo physical angles gradually to sweep hands smoothly and prevent high current draw. |
| **`TaskAudio`** | 1 | 3 | 8 KB | Pops audio paths from the queue and feeds the I2S DAC buffers. Deletes voice files post-playback. High priority to prevent stuttering. |
| **`TaskDisplay`** | 1 | 1 | 8 KB | Watches location change flags. Toggles SPI Chip Select (CS) lines based on sector calculations and draws BMPs on the target screen. |

---

## 2. GPIO Pinout & Peripherals Mapping

| Peripheral | Signal | ESP32 GPIO | Notes |
| :--- | :--- | :---: | :--- |
| **SPI Bus** | SCK | 18 | Shared by SD Card and all 4 TFT Displays. |
| | MISO | 19 | Shared. |
| | MOSI | 23 | Shared. |
| **SD Card** | CS | 5 | Dedicated Chip Select for SD. |
| **TFT Screens** | CS1 | 15 | Screen 1 Chip Select (Sector 1). |
| | CS2 | 16 | Screen 2 Chip Select (Sector 2). |
| | CS3 | 17 | Screen 3 Chip Select (Sector 3). |
| | CS4 | 4 | Screen 4 Chip Select (Sector 4). |
| | D/C | 2 | Shared Data/Command line. |
| | RST | 0 | Shared Reset line. |
| **Servos** | Servo 1 | 13 | Hand 1 PWM Signal. |
| | Servo 2 | 12 | Hand 2 PWM Signal. |
| | Servo 3 | 14 | Hand 3 PWM Signal. |
| | Servo 4 | 27 | Hand 4 PWM Signal. |
| **I2S DAC** | BCLK | 26 | Bit Clock. |
| | LRC | 25 | Word Select (Left/Right Clock). |
| | DIN | 22 | Serial Data Out (I2S DOUT). |

---

## 3. Database Schema

### `users/{userId}` (Firestore)
The ESP32 reads the user documents to synchronize the mechanical clock hands.
* **`fullName`** (`stringValue`): Used for logging and loading the user's chime `/audio/users/[fullName].mp3`.
* **`handNumber`** (`integerValue`): Identifies which physical servo hand (1-4) is assigned.
* **`targetAngle`** (`integerValue`): Target position (0-180 degrees).
* **`currentLocation`** (`stringValue`): Textual location, maps to `/images/[currentLocation].bmp` and `/audio/locations/[currentLocation].mp3`.
* **`status`** (`stringValue`): Must be `"active"` to be tracked by the clock.

### `voice_messages/{messageId}` (Firestore)
* **`status`** (`stringValue`): Message state. ESP32 processes messages with `"ready_to_play"`.
* **`audioUrl`** (`stringValue`): Public URL of the audio file in Firebase Storage.
* **`recipientName`** (`stringValue`): Intended recipient. Used for logging.

---

## 4. Shared State & IPC (Inter-Process Communication)

* **`clockUsers[NUM_SERVOS]`**: Shared volatile array containing the current state of each hand. Protected by a FreeRTOS Mutex (`stateMutex`) to prevent read/write race conditions.
* **`audioQueue`**: A thread-safe FreeRTOS Queue of capacity 10, carrying `AudioMessage` structs (housing target file paths). Used to sequence user chimes, greetings, and voice recordings.

---

## 5. Screen Selector Logic

The ESP32 calculates which physical LCD screen a hand is pointing to based on the current servo angle:
```cpp
int getScreenIndexFromAngle(int angle) {
    if (angle <= 180) { // 180-degree servos
        if (angle < 45)       return 0; // Screen 1
        else if (angle < 90)  return 1; // Screen 2
        else if (angle < 135) return 2; // Screen 3
        else                  return 3; // Screen 4
    } else { // 360-degree continuous rotation fallback
        if (angle < 90)       return 0;
        else if (angle < 180) return 1;
        else if (angle < 270) return 2;
        else                  return 3;
    }
}
```

---

## 6. Supported File Formats

* **Images**: **24-bit uncompressed BMP** format. Dimension: 240x280 pixels. Header signature must be `0x4D42` ("BM").
* **Audio**: **MP3** or **WAV** format. Mono or Stereo, decoded on-the-fly by the `ESP32-audioI2S` library and piped to the 16-bit PCM5102A DAC.
