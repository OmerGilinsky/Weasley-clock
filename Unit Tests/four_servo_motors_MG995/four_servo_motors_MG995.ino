//brown   GND
//red     external power    
//orange  D16,D17,D21,D22

#include <ESP32Servo.h>

#define servoPin1 19
#define servoPin2 21
#define servoPin3 22
#define servoPin4 32

Servo servoMotor1;
Servo servoMotor2;
Servo servoMotor3;
Servo servoMotor4;

  int center = map(0, -60, 60, 0, 180);

  int right = map(30, -60, 60, 0, 180);

  int left = map(-30, -60, 60, 0, 180);

void setup() {
  Serial.begin(115200);
  
  servoMotor1.attach(servoPin1);
  servoMotor2.attach(servoPin2);
  servoMotor3.attach(servoPin3);
  servoMotor4.attach(servoPin4);

  servoMotor1.write(center);
  delay(500);
  
  servoMotor2.write(center);
  delay(500);

  servoMotor3.write(center);
  delay(500);
  
  servoMotor4.write(center);
  delay(500);
}

void loop() {
  Serial.println("servo 1");
  servoMotor1.write(right);
  delay(500);
  servoMotor1.write(center);
  delay(500);
  servoMotor1.write(left);
  delay(500);
  servoMotor1.write(center);
  delay(500);

  Serial.println("servo 2");
  servoMotor2.write(right);
  delay(500);
  servoMotor2.write(center);
  delay(500);
  servoMotor2.write(left);
  delay(500);
  servoMotor2.write(center);
  delay(500);

  Serial.println("servo 3");
  servoMotor3.write(right);
  delay(500);
  servoMotor3.write(center);
  delay(500);
  servoMotor3.write(left);
  delay(500);
  servoMotor3.write(center);
  delay(500);

  Serial.println("servo 4");
  servoMotor4.write(right);
  delay(500);
  servoMotor4.write(center);
  delay(500);
  servoMotor4.write(left);
  delay(500);
  servoMotor4.write(center);
  delay(500);
}
