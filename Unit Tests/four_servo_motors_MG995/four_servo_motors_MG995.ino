//brown   GND
//red     external power    
//orange  D16,D17,D21,D22

#include <ESP32Servo.h>

#define servoPin1 16
#define servoPin2 17
#define servoPin3 21
#define servoPin4 22

Servo servoMotor1;
Servo servoMotor2;
Servo servoMotor3;
Servo servoMotor4;

void setup() {
  servoMotor1.attach(servoPin1);
  servoMotor2.attach(servoPin2);
  servoMotor3.attach(servoPin3);
  servoMotor4.attach(servoPin4);

  int centerServoAngle1 = map(0, -60, 60, 0, 180);
  int centerServoAngle2 = map(0, -60, 60, 0, 180);
  int centerServoAngle3 = map(0, -60, 60, 0, 180);
  int centerServoAngle4 = map(0, -60, 60, 0, 180);

  int rightServoAngle1 = map(30, -60, 60, 0, 180);
  int rightServoAngle2 = map(30, -60, 60, 0, 180);
  int rightServoAngle3 = map(30, -60, 60, 0, 180);
  int rightServoAngle4 = map(30, -60, 60, 0, 180);
  
  int leftServoAngle1 = map(-30, -60, 60, 0, 180);
  int leftServoAngle2 = map(-30, -60, 60, 0, 180);
  int leftServoAngle3 = map(-30, -60, 60, 0, 180);
  int leftServoAngle4 = map(-30, -60, 60, 0, 180);

  servoMotor1.write(centerServoAngle1);
  Serial.println("1 -> center");
  delay(500);
  servoMotor1.write(leftServoAngle1);
  Serial.println("1 -> left");
  delay(500);
  servoMotor1.write(rightServoAngle1);
  Serial.println("1 -> right");
  delay(500);

  servoMotor2.write(centerServoAngle2);
  Serial.println("2 -> center");
  delay(500);
  servoMotor2.write(leftServoAngle2);
  Serial.println("2 -> left");
  delay(500);
  servoMotor2.write(rightServoAngle2);
  Serial.println("2 -> right");
  delay(500);v

  servoMotor3.write(centerServoAngle3);
  Serial.println("3 -> center");
  delay(500);
  servoMotor3.write(leftServoAngle3);
  Serial.println("3 -> left");
  delay(500);
  servoMotor3.write(rightServoAngle3);
  Serial.println("3 -> right");
  delay(500);
  
  servoMotor4.write(centerServoAngle4);
  Serial.println("4 -> center");
  delay(500);
  servoMotor4.write(leftServoAngle4);
  Serial.println("4 -> left");
  delay(500);
  servoMotor4.write(rightServoAngle4);
  Serial.println("4 -> right");
  delay(500);
}

void loop() {}
