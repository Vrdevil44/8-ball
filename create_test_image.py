import cv2
import numpy as np

def create_synthetic_table():
    # Create a 640x480 black image
    img = np.zeros((480, 640, 3), dtype=np.uint8)
    
    # Draw a green rectangle (the table felt)
    # H: ~60 (Green in HSV is around 60. OpenCV H is 0-180, so 60 is 60/2 = 30? No, Green is 120 deg, so 60 in OpenCV)
    # Let's just use BGR green (0, 255, 0) which converts to a good HSV green.
    # Actually, let's use a slightly darker green to match felt
    felt_color = (34, 139, 34) # Forest Green in RGB? BGR: (34, 139, 34) reversed is (34, 139, 34)... wait.
    # Forest Green RGB is 34, 139, 34. BGR is 34, 139, 34... valid.
    
    cv2.rectangle(img, (100, 100), (540, 380), (34, 139, 34), -1)
    
    # Add some brown rails
    cv2.rectangle(img, (90, 90), (550, 390), (19, 69, 139), 10) # BGR Brown-ish
    
    # Save
    cv2.imwrite('test_table.jpg', img)
    print("Created test_table.jpg")

if __name__ == "__main__":
    create_synthetic_table()
