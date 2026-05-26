const bcrypt = require('bcrypt');

// Function to hash a password
async function hashPassword(password) {
    const saltRounds = 10;
    const hash = await bcrypt.hash(password, saltRounds);
    return hash;
}

// Generate hashes for default passwords
async function generateDefaultHashes() {
    console.log('Generating password hashes...\n');
    
    const admin123Hash = await hashPassword('admin123');
    console.log('admin123 hash:');
    console.log(admin123Hash);
    console.log();
    
    const staff123Hash = await hashPassword('staff123');
    console.log('staff123 hash:');
    console.log(staff123Hash);
    console.log();
    
    console.log('Copy these hashes to your database.sql file');
}

// Run if called directly
if (require.main === module) {
    generateDefaultHashes();
}

module.exports = { hashPassword };
