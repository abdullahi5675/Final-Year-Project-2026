# NELFUND Refund Portal

A web-based application built with Node.js, Express, and MySQL to automate the NELFUND school fees refund process for students who paid before loan disbursement.

## Features

### For Students
- Login using registration number (no signup required)
- Submit refund requests with remita upload
- Enter bank account details
- View refund status
- Locked form after submission (no changes allowed)

### For Staff
- Upload NELFUND approved student lists (Excel/CSV)
- View and verify pending refund requests
- Approve or reject requests with reasons
- Generate Excel batch files (100 students per batch)
- Download batches for bursary department
- Dashboard with statistics

## Technology Stack

- **Backend**: Node.js with Express.js
- **Database**: MySQL
- **Template Engine**: EJS
- **File Upload**: Multer
- **Excel Generation**: ExcelJS
- **Password Hashing**: bcrypt
- **Session Management**: express-session

## Installation

### Prerequisites

1. **Node.js** (v14 or higher)
   - Download from https://nodejs.org/

2. **MySQL** (v5.7 or higher)
   - Download from https://dev.mysql.com/downloads/mysql/

### Step 1: Extract Project Files

Extract the project folder to your desired location

### Step 2: Install Dependencies

Open terminal/command prompt in the project folder and run:

```bash
npm install
```

This will install all required packages:
- express
- express-session
- body-parser
- mysql2
- bcrypt
- multer
- exceljs
- dotenv

### Step 3: Setup Database

1. Open MySQL command line or MySQL Workbench

2. Run the database.sql file:

```bash
mysql -u root -p < database.sql
```

Or manually:
- Open MySQL command line
- Copy and paste contents of `database.sql`
- Execute

This creates:
- Database: `nelfund_refund_db`
- All required tables
- Default admin account (username: admin, password: admin123)
- Default staff account (username: staff1, password: staff123)

### Step 4: Configure Database Connection

Edit the `.env` file with your MySQL credentials:

```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=nelfund_refund_db
DB_PORT=3306
```

### Step 5: Create Required Folders

Create these folders in the project directory:

```
uploads/
  └── remita/
  └── nelfund-lists/
batches/
```

Or run (Windows):
```
mkdir uploads\remita uploads\nelfund-lists batches
```

Or run (Mac/Linux):
```bash
mkdir -p uploads/remita uploads/nelfund-lists batches
```

### Step 6: Start the Server

Run the application:

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

The server will start at: **http://localhost:3000**

## Default Login Credentials

### Admin/Staff
- Username: `admin`
- Password: `admin123`

### Staff (Testing)
- Username: `staff1`
- Password: `staff123`

**⚠️ IMPORTANT: Change these passwords after first login!**

## How to Use

### For Staff

1. **Login** at http://localhost:3000/staff/login

2. **Upload NELFUND List**:
   - Go to "Upload NELFUND List"
   - Prepare Excel file with columns:
     - Column 1: Registration Number
     - Column 2: Full Name
     - Column 3: Department
     - Column 4: Level
   - Upload the file

3. **Verify Requests**:
   - Go to "Pending Requests"
   - Review each request and remita document
   - Approve or reject with reason

4. **Generate Batch**:
   - Click "Generate Batch"
   - System creates Excel file with approved requests (max 100)
   - Download and send to bursary department

### For Students

1. **Login** at http://localhost:3000
   - Enter registration number
   - Only students in uploaded NELFUND list can login

2. **Check Eligibility**:
   - Indicate if you paid before NELFUND disbursed

3. **Submit Request** (if eligible):
   - Select payment type
   - Enter amount paid
   - Enter remita number
   - Upload remita document (PDF, JPG, PNG - Max 5MB)
   - Enter bank account details
   - Submit (form will be locked)

4. **Check Status**:
   - View dashboard for request status
   - See if approved, pending, or rejected

## Excel File Format for NELFUND List

Create Excel file (.xlsx or .csv) with this structure:

| Reg Number | Full Name | Department | Level |
|------------|-----------|------------|-------|
| CSC/2020/001 | John Doe | Computer Science | 400 |
| ENG/2020/045 | Jane Smith | Engineering | 300 |

- First row is header (will be skipped)
- All columns are required

## Project Structure

```
nelfund-refund-portal/
├── config/
│   └── database.js          # Database connection
├── middleware/
│   └── auth.js              # Authentication middleware
├── routes/
│   ├── auth.js              # Login/logout routes
│   ├── student.js           # Student routes
│   └── staff.js             # Staff routes
├── views/
│   ├── student-login.ejs    # Student login page
│   ├── staff-login.ejs      # Staff login page
│   ├── student-dashboard.ejs # Student dashboard
│   ├── refund-request.ejs   # Refund request form
│   ├── staff-dashboard.ejs  # Staff dashboard
│   ├── upload-list.ejs      # Upload NELFUND list
│   └── pending-requests.ejs # Pending requests verification
├── uploads/                 # Uploaded files
│   ├── remita/             # Student remita documents
│   └── nelfund-lists/      # NELFUND approved lists
├── batches/                 # Generated Excel batches
├── .env                     # Environment configuration
├── database.sql             # Database schema
├── server.js                # Main server file
├── package.json             # Dependencies
└── README.md               # This file
```

## Color Scheme

The portal uses a **green and white** theme:
- Primary Color: #28a745 (Green)
- Background: White
- Borders: Green (#28a745)
- Buttons: Green background with white text
- Hover: Darker green (#218838)

## Troubleshooting

### Cannot connect to database
- Check MySQL is running
- Verify credentials in `.env` file
- Ensure database exists: `nelfund_refund_db`

### File upload not working
- Ensure `uploads/remita/` folder exists
- Check folder permissions (should be writable)

### Cannot generate batch
- Ensure `batches/` folder exists
- Check folder permissions

### Port 3000 already in use
- Change PORT in `.env` file
- Or stop the process using port 3000

## Security Notes

1. **Change default passwords immediately**
2. **Use strong passwords for production**
3. **Enable HTTPS in production**
4. **Keep dependencies updated**
5. **Backup database regularly**

## Support

For issues or questions, contact your system administrator.

## License

This is a final year project. All rights reserved.
