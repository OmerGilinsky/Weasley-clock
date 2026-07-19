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

int angles1[] = {22, 1, 45, 96, 143};
int angles2[] = {22, 0, 48, 94, 141};
int angles3[] = {25, 3, 51, 98, 143};
int angles4[] = {17, 0, 33, 67, 105};

void setup() {
  Serial.begin(115200);
  
  servoMotor1.attach(servoPin1);
  servoMotor2.attach(servoPin2);
  servoMotor3.attach(servoPin3);
  servoMotor4.attach(servoPin4);

  servoMotor1.write(angles1[0]);
  delay(1000);
  
  servoMotor2.write(angles2[0]);
  delay(1000);

  servoMotor3.write(angles3[0]);
  delay(1000);
  
  servoMotor4.write(angles4[0]);
  delay(1000);
}

void loop() {
  Serial.println("servo 1");
  servoMotor1.write(angles1[1]);
  delay(1000);
  servoMotor1.write(angles1[2]);
  delay(1000);
  servoMotor1.write(angles1[3]);
  delay(1000);
  servoMotor1.write(angles1[4]);
  delay(1000);
  servoMotor1.write(angles1[0]);
  delay(1000);

  Serial.println("servo 2");
  servoMotor2.write(angles2[1]);
  delay(1000);
  servoMotor2.write(angles2[2]);
  delay(1000);
  servoMotor2.write(angles2[3]);
  delay(1000);
  servoMotor2.write(angles2[4]);
  delay(1000);
  servoMotor2.write(angles2[0]);
  delay(1000);

  Serial.println("servo 3");
  servoMotor3.write(angles3[1]);
  delay(1000);
  servoMotor3.write(angles3[2]);
  delay(1000);
  servoMotor3.write(angles3[3]);
  delay(1000);
  servoMotor3.write(angles3[4]);
  delay(1000);
  servoMotor3.write(angles3[0]);
  delay(1000);

  Serial.println("servo 4");
  servoMotor4.write(angles4[1]);
  delay(1000);
  servoMotor4.write(angles4[2]);
  delay(1000);
  servoMotor4.write(angles4[3]);
  delay(1000);
  servoMotor4.write(angles4[4]);
  delay(1000);
  servoMotor4.write(angles4[0]);
  delay(1000);
}
