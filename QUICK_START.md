# NELFUND Refund Portal - Quick Start Guide

## Installation (5 minutes)

### 1. Install Node.js
Download and install from: https://nodejs.org/
(Choose LTS version)

### 2. Install MySQL
Download and install from: https://dev.mysql.com/downloads/mysql/
Remember your root password!

### 3. Setup Project

Open terminal/command prompt in project folder:

```bash
# Install dependencies
npm install

# Create database
mysql -u root -p < database.sql
# Enter your MySQL password when prompted
```

### 4. Configure Database

Edit `.env` file:
```
DB_PASSWORD=your_mysql_password_here
```

### 5. Start Server

```bash
npm start
```

Visit: http://localhost:3000

## First Login

### Staff Login
1. Go to http://localhost:3000/staff/login
2. Username: `admin`
3. Password: `admin123`

### Upload Student List
1. Click "Upload NELFUND List"
2. Use `sample-nelfund-list.csv` (or create your own)
3. Upload the file

### Student Login
1. Go to http://localhost:3000
2. Enter a registration number from the uploaded list
3. Example: `CSC/2020/001`

## Common Issues

**Cannot connect to database?**
- Make sure MySQL is running
- Check password in `.env` file

**Port 3000 in use?**
- Change PORT in `.env` file to 3001 or another number

**File upload not working?**
- Check that folders exist: `uploads/remita/` and `batches/`

## Need Help?

Check the full README.md file for detailed documentation.

## Excel File Format

Your NELFUND list should have these columns:
1. Reg Number
2. Full Name  
3. Department
4. Level

See `sample-nelfund-list.csv` for example.

## Next Steps

1. Change default passwords
2. Upload your real NELFUND list
3. Test with student login
4. Process refund requests

Good luck with your project! 🎓
