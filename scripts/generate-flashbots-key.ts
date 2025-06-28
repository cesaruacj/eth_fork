// Script para generar una clave privada válida para Flashbots

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

// Generar una wallet nueva
const wallet = ethers.Wallet.createRandom();

console.log("\nNueva clave privada generada para Flashbots:");
console.log(wallet.privateKey);
console.log("\nDirección asociada:");
console.log(wallet.address);

// Actualizar automáticamente el archivo .env
const envPath: string = path.join(__dirname, "../.env");
let envContent: string = fs.readFileSync(envPath, "utf8");

// Reemplazar la línea existente o añadir una nueva
if (envContent.includes("FLASHBOTS_KEY=")) {
  envContent = envContent.replace(
    /FLASHBOTS_KEY=.*/,
    `FLASHBOTS_KEY=${wallet.privateKey}`
  );
} else {
  envContent += `\nFLASHBOTS_KEY=${wallet.privateKey}`;
}

fs.writeFileSync(envPath, envContent);
console.log("\n✅ Clave privada guardada en .env");