//brown   GND
//red     external power    
//orange  D32,D35,D34,D22

#include <servo.h>

#define servoPin1 32
#define servoPin2 35
#define servoPin2 34
#define servoPin2 22

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
  int centerServoAngle2 = map(0, -60, 60, 0, 180);
  int centerServoAngle2 = map(0, -60, 60, 0, 180);

  servoMotor1.write(centerServoAngle1);
  servoMotor1.write(centerServoAngle2);
  servoMotor1.write(centerServoAngle3);
  servoMotor1.write(centerServoAngle4);

  delay(1000);

  int rightServoAngle1 = map(30, -60, 60, 0, 180);
  int leftServoAngle2 = map(-30, -60, 60, 0, 180);
  int rightServoAngle3 = map(30, -60, 60, 0, 180);
  int leftServoAngle4 = map(-30, -60, 60, 0, 180);

  servoMotor1.write(rightServoAngle1);
  servoMotor1.write(leftServoAngle2);
  servoMotor3.write(rightServoAngle3);
  servoMotor1.write(leftServoAngle4);

  delay(1000);

  int leftServoAngle1 = map(-30, -60, 60, 0, 180);
  int rightServoAngle2 = map(30, -60, 60, 0, 180);
  int leftServoAngle3 = map(-30, -60, 60, 0, 180);
  int rightServoAngle4 = map(30, -60, 60, 0, 180);

  servoMotor1.write(leftServoAngle1);
  servoMotor1.write(rightServoAngle2);
  servoMotor1.write(leftServoAngle3);
  servoMotor3.write(rightServoAngle4);
}

void loop() {
  // put your main code here, to run repeatedly:

}
