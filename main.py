import cv2
import numpy as np
from src.cv.table_detector import TableDetector

import argparse

def main():
    parser = argparse.ArgumentParser(description='AR 8-Ball Pool Assistant')
    parser.add_argument('--image', type=str, help='Path to image file to process')
    args = parser.parse_args()

    # Initialize Table Detector
    table_detector = TableDetector()

    if args.image:
        frame = cv2.imread(args.image)
        if frame is None:
            print(f"Error: Could not read image {args.image}")
            return
        
        # Process single frame
        process_frame(frame, table_detector, wait=0)
    else:
        # Open video capture
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            print("Error: Could not open video capture.")
            return

        while True:
            ret, frame = cap.read()
            if not ret:
                print("Failed to grab frame")
                break
            
            if not process_frame(frame, table_detector, wait=1):
                break

        cap.release()

    cv2.destroyAllWindows()

def process_frame(frame, detector, wait=1):
    # detection
    table_contour, table_mask = detector.detect_table(frame)

    # distinct visualization
    if table_contour is not None:
        print("Table detected!")
        # Draw table contour
        cv2.drawContours(frame, [table_contour], -1, (0, 255, 0), 2)
        
        # Draw corners
        epsilon = 0.02 * cv2.arcLength(table_contour, True)
        approx = cv2.approxPolyDP(table_contour, epsilon, True)
        for point in approx:
            cv2.circle(frame, tuple(point[0]), 5, (0, 0, 255), -1)
            
        print(f"Corners detected: {len(approx)}")
    else:
        print("No table detected.")

    # Show the frame
    # Note: cv2.imshow might fail in some headless environments, but we'll try.
    # If it fails, the script might crash, so we could wrap in try/except or just rely on console output.
    try:
        cv2.imshow('AR 8-Ball', frame)
        if table_mask is not None:
             cv2.imshow('Table Mask', table_mask)
    except Exception as e:
        pass # Ignore display errors in headless

    if wait > 0:
        if cv2.waitKey(wait) & 0xFF == ord('q'):
            return False
    else:
        # For single image, wait indefinitely until key press
        cv2.waitKey(0)

    return True

if __name__ == "__main__":
    main()
