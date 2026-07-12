# Wesley's Clock - ESP32 Firmware Quick Start Guide

This project contains the C++ firmware for **Wesley's Clock** physical prototype. The firmware runs on an ESP32 microcontroller, connecting to Firebase (Firestore & Storage) to coordinate motorized clock hands (servos), multi-screen location displays (TFT SPI LCDs), and synchronized audio alerts (I2S DAC).

---

## 🛠️ Required Hardware

1. **Microcontroller**: ESP32 DevKit V1 (or compatible board).
2. **Servos**: 4x MG995 high-torque servo motors.
3. **Displays**: 4x TFT LCD SPI screens (240x280 pixels, ST7789 driver).
4. **Storage**: SD Card module (SPI) + microSD card (formatted to FAT32).
5. **Audio**: PCM5102A I2S DAC module + Speaker.
6. **Power Supply**: External 5V/3A regulator (Servos require separate power!).

---

## 💻 Software Dependencies & Setup

### 1. Arduino IDE Configuration
* Ensure you are using **Arduino IDE 2.0+**.
* Add the ESP32 boards manager URL in Preferences:
  `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
* Open Boards Manager, search for **esp32** and install version **2.0.17** (do not install v3.0+ to prevent library incompatibilities).

### 2. Install Required Libraries
Open the **Library Manager** (`Ctrl+Shift+I` / `Cmd+Shift+I`) and install:
* **Firebase ESP Client** (by Mobizt)
* **ESP32Servo** (by Kevin Harrington)
* **Adafruit GFX Library** (by Adafruit)
* **Adafruit ST7789 Library** (by Adafruit)
* **ESP32-audioI2S** (by Wolle / WolleSchreiber)
* **ArduinoJson** (by Benoit Blanchon)

---

## 🚀 How to Run the Project

1. **Open the Sketch**:
   Open **[wesleys_clock_esp32.ino](file:///C:/Users/lital/Desktop/weasley_projec/wesleys_clock_esp32/wesleys_clock_esp32.ino)** in Arduino IDE. The editor will automatically open all associated `.cpp` and `.h` files as tabs.

2. **Configure Settings**:
   Open the **[Config.h](file:///C:/Users/lital/Desktop/weasley_projec/wesleys_clock_esp32/Config.h)** tab and fill in:
   * WiFi SSID and password.
   * Firebase API Key and Project ID.
   * Firebase Auth email and password.

3. **Prepare the SD Card**:
   Format a microSD card to FAT32 and populate it with the following structure:
   ```text
   [microSD Card]
    ├── audio/
    │    ├── arrived_at.mp3           <-- Default arrived sound
    │    ├── users/
    │    │    ├── Alice.mp3           <-- User specific arrival sound
    │    │    └── Bob.mp3
    │    └── locations/
    │         ├── HOME.mp3            <-- Location specific arrival sound
    │         └── default.mp3
    └── images/
         ├── HOME.bmp                 <-- 240x280 24-bit uncompressed BMP
         └── WORK.bmp
   ```

4. **Select Board & Port**:
   * Go to **Tools** -> **Board** -> **ESP32 Arduino** -> select **DOIT ESP32 DEVKIT V1**.
   * Go to **Tools** -> **Port** -> select your connected COM port.

5. **Upload**:
   Click the **Upload** arrow button (or press `Ctrl+U`) to compile and burn the firmware onto the ESP32. Open the **Serial Monitor** (set baud rate to **115200**) to view real-time debug outputs.
