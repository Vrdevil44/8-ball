import cv2
import numpy as np

class TableDetector:
    def __init__(self):
        # Default green felt HSV range (approximate, needs tuning)
        # H: 35-85, S: 50-255, V: 50-255 (from guide)
        self.lower_green = np.array([35, 50, 50])
        self.upper_green = np.array([85, 255, 255])
        
        # For Blue felt (if needed later): H: 90-130
    
    def detect_table(self, frame):
        """
        Detects the pool table in the frame.
        Returns:
            contour: The largest contour found (assumed to be the table)
            mask: The binary mask used for detection
        """
        # Convert to HSV
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        
        # Create mask
        mask = cv2.inRange(hsv, self.lower_green, self.upper_green)
        
        # Morphological operations to clean noise
        kernel = np.ones((5, 5), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel) # Remove small noise
        
        # Find contours
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        if not contours:
            return None, mask
            
        # Assume the largest contour is the table
        table_contour = max(contours, key=cv2.contourArea)
        
        # Filter by area (to avoid detecting small green objects)
        if cv2.contourArea(table_contour) < 1000: # Threshold needs tuning
            return None, mask

        return table_contour, mask
