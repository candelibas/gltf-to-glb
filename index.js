import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class GLTFToGLBConverter {
    constructor(inputFolder, outputFolder) {
        this.inputFolder = inputFolder;
        this.outputFolder = outputFolder;

        // Ensure output folder exists
        if (!fs.existsSync(outputFolder)) {
            fs.mkdirSync(outputFolder, { recursive: true });
        }
    }

    async convertAll() {
        const gltfFiles = fs.readdirSync(this.inputFolder)
            .filter(file => file.endsWith('.gltf'));

        if (gltfFiles.length === 0) {
            console.log('No .gltf files found in the input folder.');
            return;
        }

        console.log(`Found ${gltfFiles.length} GLTF file(s) to convert:`);

        for (const gltfFile of gltfFiles) {
            try {
                await this.convertGLTFToGLB(gltfFile);
                console.log(`✓ Converted: ${gltfFile}`);
            } catch (error) {
                console.error(`✗ Failed to convert ${gltfFile}:`, error.message);
            }
        }
    }

    async convertGLTFToGLB(gltfFileName) {
        const gltfPath = path.join(this.inputFolder, gltfFileName);
        const gltfData = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));

        // Create a deep copy to avoid modifying original
        const modifiedGltf = JSON.parse(JSON.stringify(gltfData));
        const baseName = path.parse(gltfFileName).name;

        // Collect all binary data in order
        const binaryChunks = [];
        let totalSize = 0;

        // First, process existing buffers (.bin files)
        if (modifiedGltf.buffers) {
            for (let i = 0; i < modifiedGltf.buffers.length; i++) {
                const buffer = modifiedGltf.buffers[i];
                if (buffer.uri && !buffer.uri.startsWith('data:')) {
                    const bufferPath = path.join(this.inputFolder, buffer.uri);
                    if (fs.existsSync(bufferPath)) {
                        const bufferData = fs.readFileSync(bufferPath);
                        binaryChunks.push(bufferData);

                        // Update existing buffer views to point to correct offsets
                        if (modifiedGltf.bufferViews) {
                            for (const bufferView of modifiedGltf.bufferViews) {
                                if (bufferView.buffer === i) {
                                    bufferView.byteOffset = (bufferView.byteOffset || 0) + totalSize;
                                    bufferView.buffer = 0; // All data goes into buffer 0 in GLB
                                }
                            }
                        }

                        totalSize += bufferData.length;
                        // Pad to 4-byte alignment
                        const padding = (4 - (totalSize % 4)) % 4;
                        if (padding > 0) {
                            binaryChunks.push(Buffer.alloc(padding, 0));
                            totalSize += padding;
                        }

                        // Remove URI since we're embedding
                        delete buffer.uri;
                    }
                }
            }

            // Update buffer size and remove extra buffers
            if (modifiedGltf.buffers.length > 0) {
                modifiedGltf.buffers = [{
                    byteLength: totalSize
                }];
            }
        }

        // Process images/textures
        if (modifiedGltf.images) {
            for (let i = 0; i < modifiedGltf.images.length; i++) {
                const image = modifiedGltf.images[i];
                if (image.uri && !image.uri.startsWith('data:')) {
                    const imagePath = path.join(this.inputFolder, image.uri);
                    if (fs.existsSync(imagePath)) {
                        const imageData = fs.readFileSync(imagePath);
                        const mimeType = this.getMimeType(path.extname(image.uri));

                        // Create buffer view for this image
                        if (!modifiedGltf.bufferViews) modifiedGltf.bufferViews = [];
                        const bufferViewIndex = modifiedGltf.bufferViews.length;

                        modifiedGltf.bufferViews.push({
                            buffer: 0,
                            byteOffset: totalSize,
                            byteLength: imageData.length
                        });

                        // Update image to reference buffer view
                        delete image.uri;
                        image.bufferView = bufferViewIndex;
                        image.mimeType = mimeType;

                        binaryChunks.push(imageData);
                        totalSize += imageData.length;

                        // Pad to 4-byte alignment
                        const padding = (4 - (totalSize % 4)) % 4;
                        if (padding > 0) {
                            binaryChunks.push(Buffer.alloc(padding, 0));
                            totalSize += padding;
                        }
                    }
                }
            }
        }

        // Update final buffer size
        if (modifiedGltf.buffers && modifiedGltf.buffers.length > 0) {
            modifiedGltf.buffers[0].byteLength = totalSize;
        }

        // Combine all binary data
        const combinedBuffer = Buffer.concat(binaryChunks);

        // Create GLB
        const glbBuffer = this.createGLB(modifiedGltf, combinedBuffer);

        // Write GLB file
        const outputPath = path.join(this.outputFolder, `${baseName}.glb`);
        fs.writeFileSync(outputPath, glbBuffer);
    }

    combineBuffers(gltfData, resources) {
        // This method is no longer used, but keeping for compatibility
        return Buffer.alloc(0);
    }

    createGLB(gltfData, binaryBuffer) {
        // Clean up the GLTF data
        const cleanGltf = JSON.parse(JSON.stringify(gltfData));

        // Ensure we have required fields
        if (!cleanGltf.asset) {
            cleanGltf.asset = { version: "2.0" };
        }

        const gltfString = JSON.stringify(cleanGltf);
        const gltfBuffer = Buffer.from(gltfString, 'utf8');

        // Calculate padding for JSON chunk (must be multiple of 4)
        const jsonLength = gltfBuffer.length;
        const jsonPadding = (4 - (jsonLength % 4)) % 4;
        const jsonChunkLength = jsonLength + jsonPadding;

        // Create padded JSON buffer
        const paddedJsonBuffer = Buffer.alloc(jsonChunkLength, 0x20); // Fill with spaces
        gltfBuffer.copy(paddedJsonBuffer, 0);

        // Calculate padding for binary chunk (must be multiple of 4)
        const binaryLength = binaryBuffer.length;
        const binaryPadding = (4 - (binaryLength % 4)) % 4;
        const binaryChunkLength = binaryLength + binaryPadding;

        // Create padded binary buffer
        const paddedBinaryBuffer = Buffer.alloc(binaryChunkLength, 0);
        binaryBuffer.copy(paddedBinaryBuffer, 0);

        // Calculate total GLB size
        const totalLength = 12 + // GLB header
            8 + jsonChunkLength + // JSON chunk header + data
            (binaryChunkLength > 0 ? 8 + binaryChunkLength : 0); // Binary chunk header + data (if exists)

        // Create GLB header (12 bytes)
        const header = Buffer.alloc(12);
        header.writeUInt32LE(0x46546C67, 0); // Magic: "glTF"
        header.writeUInt32LE(2, 4);          // Version: 2
        header.writeUInt32LE(totalLength, 8); // Total length

        // Create JSON chunk header (8 bytes)
        const jsonChunkHeader = Buffer.alloc(8);
        jsonChunkHeader.writeUInt32LE(jsonChunkLength, 0); // Chunk length
        jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4);      // Chunk type: "JSON"

        const chunks = [header, jsonChunkHeader, paddedJsonBuffer];

        // Add binary chunk if we have binary data
        if (binaryChunkLength > 0) {
            const binaryChunkHeader = Buffer.alloc(8);
            binaryChunkHeader.writeUInt32LE(binaryChunkLength, 0); // Chunk length
            binaryChunkHeader.writeUInt32LE(0x004E4942, 4);        // Chunk type: "BIN\0"

            chunks.push(binaryChunkHeader, paddedBinaryBuffer);
        }

        return Buffer.concat(chunks);
    }

    getMimeType(extension) {
        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
            '.webp': 'image/webp'
        };
        return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
    }
}

// Usage
async function main() {
    const args = process.argv.slice(2);

    if (args.length < 1) {
        console.log('Usage: node index.js <input-folder> [output-folder]');
        console.log('Example: node index.js ./models ./output');
        process.exit(1);
    }

    const inputFolder = args[0];
    const outputFolder = args[1] || path.join(inputFolder, 'glb_output');

    if (!fs.existsSync(inputFolder)) {
        console.error(`Input folder does not exist: ${inputFolder}`);
        process.exit(1);
    }

    console.log(`Converting GLTF files from: ${inputFolder}`);
    console.log(`Output folder: ${outputFolder}`);
    console.log('---');

    const converter = new GLTFToGLBConverter(inputFolder, outputFolder);
    await converter.convertAll();

    console.log('---');
    console.log('Conversion complete!');
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default GLTFToGLBConverter;