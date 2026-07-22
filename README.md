## Weasley-clock Project by : Avigail Ben David & Omer Gilinsky & Lital mirovoy
  
## Details about the project
Weasley's Clock is an IoT-based physical grandfather clock inspired by the Harry Potter universe. It displays the real-time physical locations of family members using motorized clock hands (servos) and customized LCD screens. It also receives and plays recorded voice messages dynamically when family members arrive home. The system integrates a physical ESP32 microcontroller, a serverless Firebase backend (Cloud Functions, Firestore, Storage), and a Flutter web app.
 
## Folder description :
* Weasly_clock: source code for the esp side (firmware).
* wesleys_clock_backend : Firebase Cloud Functions (v2) and database rules configuration for backend logic.
* Documentation: wiring diagram + project poster.
* Unit Tests: tests for individual hardware components (input / output devices)
* flutter_app : dart code for our Flutter app.

## ESP32 SDK version used in this project: 
ESP32 Arduino Core version 2.0.17 (using ESP32 Dev Module)

## Arduino/ESP32 libraries used in this project:
* Firebase ESP Client - version 4.4.14 (by Mobizt)
* ESP32Servo - version 1.1.8 (by Kevin Harrington)
* ESP32-audioI2S - version 3.0.0 (by Wolle)
* ArduinoJson - version 6.21.3 (by Benoit Blanchon)
* Adafruit GFX Library & ST7789 Library
## hardware :
* ESP32 Dev Module
* MG995 Servo Motors
* ST7789 Color TFT LCD (240x280)
* MAX98357A I2S Audio DAC
* 8Ω 3W Audio Speaker
* Micro SD Card Module (SPI)

## Connection diagram:
The connection diagrams and pin schematics for the SPI bus (SD Card and TFT Displays), I2S DAC, and MG995 servos are documented under the Documentation folder.

## Project Poster:
Poster files can be found under the Assets / Documentation folders.
 
This project is part of ICST - The Interdisciplinary Center for Smart Technologies, Taub Faculty of Computer Science, Technion
https://icst.cs.technion.ac.il/
