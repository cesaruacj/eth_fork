// scripts/setup-dexes.ts
import { ethers } from "hardhat";
import { DEPLOYED_CONTRACTS } from "../config/addresses";

async function main() {
  console.log("🔄 Inicializando DEXes en FlashLoanArbitrage...");
  
  // Get the first signer (account)
  const [deployer] = await ethers.getSigners();
  console.log("🔑 Using account:", deployer.address);
  
  // Connect to deployed FlashLoanArbitrage contract
  const flashLoanArbitrage = await ethers.getContractAt(
    "FlashLoanArbitrage", 
    DEPLOYED_CONTRACTS.FLASH_LOAN_ARBITRAGE,
    deployer
  );
  
  // Verify ownership
  const owner = await flashLoanArbitrage.owner();
  console.log("🔐 Contract owner:", owner);
  console.log("🔐 Deployer address:", deployer.address);
  
  try {
    // Setup DEXes
    const tx = await flashLoanArbitrage.setupAllDexes({
      gasLimit: 9000000
    });
    
    console.log("⏳ Transaction sent:", tx.hash);
    await tx.wait();
    console.log("✅ DEXes successfully initialized");
  } catch (error) {
    console.error("❌ Failed to initialize DEXes:", error.message);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("❌ Script execution failed:", error);
  process.exitCode = 1;
});