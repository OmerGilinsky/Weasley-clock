#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <SPI.h>

#define TFT_DC    2
#define TFT_RES   4
#define TFT_SDA  23
#define TFT_SCL  18

Adafruit_ST7789 tft = Adafruit_ST7789(-1, TFT_DC, -1);

// Custom color definitions for our animation
#define NAVY        0x000F
#define BRIGHT_RED  0xF800
#define PINK        0xF81F

void setup() {
  Serial.begin(115200);
  Serial.println("--- Starting Mirrored Animation ---");

  // Hardware Reset Pulse
  pinMode(TFT_RES, OUTPUT);
  digitalWrite(TFT_RES, HIGH);
  delay(50);
  digitalWrite(TFT_RES, LOW);
  delay(50);
  digitalWrite(TFT_RES, HIGH);
  delay(150);

  tft.init(240, 240, SPI_MODE2); 
  tft.setRotation(0);
  
  // Clear screen to base background color once
  tft.fillScreen(NAVY);
}

// --- ANIMATION FRAME 1: Small Heart ---
void drawFrame1() {
  // Clear just the area where the heart changes to prevent full-screen flicker
  tft.fillCircle(120, 120, 60, NAVY); 
  
  // Draw a smaller heart using overlapping circles and a triangle
  tft.fillCircle(95, 110, 25, BRIGHT_RED);
  tft.fillCircle(145, 110, 25, BRIGHT_RED);
  tft.fillTriangle(71, 122, 169, 122, 120, 175, BRIGHT_RED);
  
  // Update text descriptor
  tft.setCursor(65, 40);
  tft.setTextColor(ST77XX_WHITE, NAVY);
  tft.setTextSize(2);
  tft.print("BEAT... ");
}

// --- ANIMATION FRAME 2: Large Heart ---
void drawFrame2() {
  // Draw a larger, vibrant heart overlapping the previous coordinates
  tft.fillCircle(90, 105, 35, PINK);
  tft.fillCircle(150, 105, 35, PINK);
  tft.fillTriangle(56, 120, 184, 120, 120, 190, PINK);
  
  // Update text descriptor
  tft.setCursor(65, 40);
  tft.setTextColor(PINK, NAVY);
  tft.setTextSize(2);
  tft.print("...BOOM!");
}

void loop() {
  // Frame 1
  drawFrame1();
  delay(400); // Control the frame rate (400ms per frame)

  // Frame 2
  drawFrame2();
  delay(250); // Shorter delay on the expansion for a realistic pulse rhythm
}