//brown   GND
//red     external power    
//orange  D5,D21,D22,D32

#include <ESP32Servo.h>

#define servoPin1 5
#define servoPin2 21
#define servoPin3 22
#define servoPin4 32

Servo servoMotor1;
Servo servoMotor2;
Servo servoMotor3;
Servo servoMotor4;

void setup() {
  Serial.begin(115200);
  
  servoMotor1.attach(servoPin1);
  servoMotor2.attach(servoPin2);
  servoMotor3.attach(servoPin3);
  servoMotor4.attach(servoPin4);

  servoMotor1.write(0);
  delay(1000);
  
  servoMotor2.write(0);
  delay(1000);

  servoMotor3.write(0);
  delay(1000);
  
  servoMotor4.write(0);
  delay(1000);
}

void loop() {
  Serial.println("servo 1");
  servoMotor1.write(22);
  delay(1000);
  servoMotor1.write(45);
  delay(1000);
  servoMotor1.write(90);
  delay(1000);
  servoMotor1.write(135);
  delay(1000);
  servoMotor1.write(0);
  delay(1000);

  Serial.println("servo 2");
  servoMotor2.write(22);
  delay(1000);
  servoMotor2.write(45);
  delay(1000);
  servoMotor2.write(90);
  delay(1000);
  servoMotor2.write(135);
  delay(1000);
  servoMotor2.write(0);
  delay(1000);

  Serial.println("servo 3");
  servoMotor3.write(22);
  delay(1000);
  servoMotor3.write(45);
  delay(1000);
  servoMotor3.write(90);
  delay(1000);
  servoMotor3.write(135);
  delay(1000);
  servoMotor3.write(0);
  delay(1000);

  Serial.println("servo 4");
  servoMotor4.write(22);
  delay(1000);
  servoMotor4.write(45);
  delay(1000);
  servoMotor4.write(90);
  delay(1000);
  servoMotor4.write(135);
  delay(1000);
  servoMotor4.write(0);
  delay(1000);
}
