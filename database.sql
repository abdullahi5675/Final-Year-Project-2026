-- NELFUND Refund Portal Database Schema

CREATE DATABASE IF NOT EXISTS nelfund_refund_db;
USE nelfund_refund_db;

-- Drop existing tables
DROP TABLE IF EXISTS batch_files;
DROP TABLE IF EXISTS refund_batches;
DROP TABLE IF EXISTS bank_details;
DROP TABLE IF EXISTS remita_documents;
DROP TABLE IF EXISTS refund_requests;
DROP TABLE IF EXISTS students;
DROP TABLE IF EXISTS nelfund_approved_lists;
DROP TABLE IF EXISTS staff;

-- Staff table
CREATE TABLE staff (
    staff_id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(100),
    role ENUM('admin', 'staff') DEFAULT 'staff',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL
);

-- NELFUND Approved Lists
CREATE TABLE nelfund_approved_lists (
    list_id INT AUTO_INCREMENT PRIMARY KEY,
    batch_reference VARCHAR(100) NOT NULL,
    upload_date DATE NOT NULL,
    uploaded_by INT NOT NULL,
    total_students INT DEFAULT 0,
    file_path VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploaded_by) REFERENCES staff(staff_id)
);

-- Students
CREATE TABLE students (
    reg_number VARCHAR(50) PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    department VARCHAR(100),
    level VARCHAR(20),
    list_id INT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (list_id) REFERENCES nelfund_approved_lists(list_id)
);

-- Refund Requests
CREATE TABLE refund_requests (
    request_id INT AUTO_INCREMENT PRIMARY KEY,
    reg_number VARCHAR(50) NOT NULL,
    paid_before_disbursement BOOLEAN DEFAULT TRUE,
    refund_amount DECIMAL(10, 2),
    payment_type ENUM('first_installment', 'second_installment', 'full_payment') NOT NULL,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    rejection_reason TEXT,
    verified_by INT,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    verified_at TIMESTAMP NULL,
    is_locked BOOLEAN DEFAULT FALSE,
    batch_id INT NULL,
    FOREIGN KEY (reg_number) REFERENCES students(reg_number),
    FOREIGN KEY (verified_by) REFERENCES staff(staff_id)
);

-- Remita Documents
CREATE TABLE remita_documents (
    document_id INT AUTO_INCREMENT PRIMARY KEY,
    request_id INT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(255) NOT NULL,
    amount_paid DECIMAL(10, 2) NOT NULL,
    payment_date DATE,
    remita_number VARCHAR(100),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES refund_requests(request_id) ON DELETE CASCADE
);

-- Bank Details
CREATE TABLE bank_details (
    bank_id INT AUTO_INCREMENT PRIMARY KEY,
    request_id INT NOT NULL,
    account_name VARCHAR(100) NOT NULL,
    account_number VARCHAR(20) NOT NULL,
    bank_name VARCHAR(100) NOT NULL,
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES refund_requests(request_id) ON DELETE CASCADE
);

-- Refund Batches
CREATE TABLE refund_batches (
    batch_id INT AUTO_INCREMENT PRIMARY KEY,
    batch_number VARCHAR(50) UNIQUE NOT NULL,
    student_count INT DEFAULT 0,
    total_amount DECIMAL(12, 2) DEFAULT 0.00,
    created_date DATE NOT NULL,
    created_by INT NOT NULL,
    is_downloaded BOOLEAN DEFAULT FALSE,
    downloaded_at TIMESTAMP NULL,
    downloaded_by INT,
    FOREIGN KEY (created_by) REFERENCES staff(staff_id),
    FOREIGN KEY (downloaded_by) REFERENCES staff(staff_id)
);

-- Batch Files
CREATE TABLE batch_files (
    file_id INT AUTO_INCREMENT PRIMARY KEY,
    batch_id INT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(255) NOT NULL,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES refund_batches(batch_id)
);

-- Insert default admin (password: admin123)
INSERT INTO staff (username, password_hash, full_name, email, role) 
VALUES ('admin', '$2b$10$rJZ2qF0LmWZvD9Z5oZ5oZOZ5oZ5oZ5oZ5oZ5oZ5oZ5oZ5oZ5oZ5oO', 'Administrator', 'admin@nelfund.edu', 'admin');

-- Insert test staff (password: staff123)
INSERT INTO staff (username, password_hash, full_name, email, role) 
VALUES ('staff1', '$2b$10$rJZ2qF0LmWZvD9Z5oZ5oZOZ5oZ5oZ5oZ5oZ5oZ5oZ5oZ5oZ5oZ5oO', 'Staff Member', 'staff@nelfund.edu', 'staff');

-- Create indexes
CREATE INDEX idx_student_list ON students(list_id);
CREATE INDEX idx_request_status ON refund_requests(status);
CREATE INDEX idx_request_reg ON refund_requests(reg_number);
