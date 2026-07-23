import os
from PIL import Image

def generate_icons():
    src_path = 'icon-source.jpg'
    if not os.path.exists(src_path):
        print(f"Error: {src_path} not found.")
        return

    # Open image
    img = Image.open(src_path)

    # Standard PWA sizes
    sizes = [72, 96, 128, 144, 152, 192, 384, 512]
    
    # Create directory for icons
    os.makedirs('icons', exist_ok=True)
    
    # Save target icons
    for size in sizes:
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(f'icons/icon-{size}x{size}.png', 'PNG')
        print(f"Generated icons/icon-{size}x{size}.png")

    # Also save a standard favicon
    resized_favicon = img.resize((32, 32), Image.Resampling.LANCZOS)
    resized_favicon.save('favicon.ico', 'ICO')
    print("Generated favicon.ico")

if __name__ == '__main__':
    generate_icons()
