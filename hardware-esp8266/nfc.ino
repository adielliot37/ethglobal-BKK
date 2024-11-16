#include <SPI.h>
#include <MFRC522.h>
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ESP8266HTTPClient.h>

// RFID Pins
#define RST_PIN D1
#define SS_PIN D2  


const char* ssid = "mavi";
const char* password = "ethhelper";

// Server API URLs
const String getUserURL = "https://arx.onrender.com/api/get_user?uid="; 
const String requestHelpURL = "https://arx.onrender.com/api/request-help"; 

// Reader Configuration
const int table_no = 1; 

MFRC522 mfrc522(SS_PIN, RST_PIN); // Create MFRC522 instance
WiFiClientSecure wifiClient;      
unsigned long lastReadTime = 0;   
String lastUID = "";             
const unsigned long cooldownPeriod = 20000; 

void setup() {
  Serial.begin(115200); 
  while (!Serial)
    ;

  SPI.begin();          
  mfrc522.PCD_Init();   

  // Connect to Wi-Fi
  Serial.print("Connecting to Wi-Fi...");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    Serial.print(".");
  }
  Serial.println("\nWi-Fi connected!");
  Serial.println("IP address: " + WiFi.localIP().toString()); 

  
  wifiClient.setInsecure(); 
  Serial.println("Place your RFID card near the reader...");
}

void loop() {
  
  if (!mfrc522.PICC_IsNewCardPresent()) {
    return;
  }

  
  if (!mfrc522.PICC_ReadCardSerial()) {
    return;
  }

  // Get UID
  String uid = "";
  for (byte i = 0; i < mfrc522.uid.size; i++) {
    uid += String(mfrc522.uid.uidByte[i] < 0x10 ? "0" : "");
    uid += String(mfrc522.uid.uidByte[i], HEX);
  }
  uid.toUpperCase(); 
  
  unsigned long currentTime = millis();
  if (uid == lastUID && (currentTime - lastReadTime) < cooldownPeriod) {
    
    return;
  }

  
  lastUID = uid;
  lastReadTime = currentTime;

  Serial.println("Card UID: " + uid);

  
  fetchAndSendHelpRequest(uid);

  
  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();
}

void fetchAndSendHelpRequest(String uid) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi not connected. Cannot fetch data.");
    return;
  }

  // Fetch user data
  HTTPClient http;
  String url = getUserURL + uid;
  http.begin(wifiClient, url); 
  int httpCode = http.GET(); 

  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    Serial.println("User Data: " + payload);

    String user_name = extractJSONValue(payload, "name");
    String user_tg = extractJSONValue(payload, "tg_username");

    if (user_name.length() > 0 && user_tg.length() > 0) {
      
      sendHelpRequest(user_name, user_tg);
    } else {
      Serial.println("Invalid user data.");
    }
  } else {
    Serial.println("Failed to fetch user data.");
    Serial.println("HTTP Status Code: " + String(httpCode));
    Serial.println("Error: " + String(http.errorToString(httpCode).c_str()));
  }

  http.end(); 
}

void sendHelpRequest(String user_name, String user_tg) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi not connected. Cannot send help request.");
    return;
  }

  HTTPClient http;
  http.begin(wifiClient, requestHelpURL); 
  
  String jsonPayload = "{";
  jsonPayload += "\"table_no\": " + String(table_no) + ",";
  jsonPayload += "\"user_name\": \"" + user_name + "\",";
  jsonPayload += "\"user_tg\": \"" + user_tg + "\"";
  jsonPayload += "}";

  http.addHeader("Content-Type", "application/json");
  int httpCode = http.POST(jsonPayload); 

  if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_CREATED) {
    String response = http.getString();
    Serial.println("Help Request Sent: " + response);
  } else {
    Serial.println("Failed to send help request.");
    Serial.println("HTTP Status Code: " + String(httpCode));
    Serial.println("Error: " + String(http.errorToString(httpCode).c_str()));
  }

  http.end(); 
}


String extractJSONValue(String json, String key) {
  int startIndex = json.indexOf("\"" + key + "\":\"") + key.length() + 4;
  int endIndex = json.indexOf("\"", startIndex);
  return json.substring(startIndex, endIndex);
}
