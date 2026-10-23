#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -euo pipefail

# Text styling
BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
BLUE="\033[0;34m"
NC="\033[0m" # No Color

echo -e "${BLUE}${BOLD}=== Vector Core Project Cleanup Tool ===${NC}\n"

# Check if running in the correct directory
if [ ! -d "app" ] || [ ! -d "static" ]; then
    echo -e "${RED}Error: Please run this script from the root of your 'vector_core' project.${NC}"
    exit 1
fi

# 1. Gather files to clean up
echo -e "${BOLD}Scanning for temporary and backup files...${NC}"

BACKUP_FILES=$(find . -type f \( -name "*.bak" -o -name "*.bak[0-9]*" \))
PYCACHE_DIRS=$(find . -type d -name "__pycache__")
DB_FILES=$(find . -type f -name "vector_core.db")

# 2. Preview backup files
if [ -n "$BACKUP_FILES" ]; then
    echo -e "\n${YELLOW}The following backup files will be DELETED:${NC}"
    echo "$BACKUP_FILES" | sed 's/^/  - /'
else
    echo -e "\n${GREEN}✓ No backup (*.bak) files found.${NC}"
fi

# 3. Preview pycache directories
if [ -n "$PYCACHE_DIRS" ]; then
    echo -e "\n${YELLOW}The following bytecode cache directories will be DELETED:${NC}"
    echo "$PYCACHE_DIRS" | sed 's/^/  - /'
else
    echo -e "\n${GREEN}✓ No __pycache__ directories found.${NC}"
fi

# 4. Preview local DB files
if [ -n "$DB_FILES" ]; then
    echo -e "\n${YELLOW}The following local database will be DELETED:${NC}"
    echo "$DB_FILES" | sed 's/^/  - /'
fi

# Confirm action
if [ -z "$BACKUP_FILES" ] && [ -z "$PYCACHE_DIRS" ] && [ -z "$DB_FILES" ]; then
    echo -e "\n${GREEN}Nothing to clean up! Your project directory is already pristine.${NC}"
    exit 0
fi

echo -e "\n${RED}${BOLD}WARNING: This action cannot be undone!${NC}"
read -p "Do you want to proceed with the deletion? (y/N): " CONFIRM

if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "\n${BLUE}Cleaning up...${NC}"
    
    # Safely delete backups
    if [ -n "$BACKUP_FILES" ]; then
        echo "$BACKUP_FILES" | xargs rm -f
        echo -e "${GREEN}✓ Deleted backup files.${NC}"
    fi
    
    # Safely delete pycache
    if [ -n "$PYCACHE_DIRS" ]; then
        echo "$PYCACHE_DIRS" | xargs rm -rf
        echo -e "${GREEN}✓ Deleted __pycache__ directories.${NC}"
    fi

    # Safely delete local DB
    if [ -n "$DB_FILES" ]; then
        echo "$DB_FILES" | xargs rm -f
        echo -e "${GREEN}✓ Deleted local SQLite database.${NC}"
    fi
    
    echo -e "\n${GREEN}${BOLD}✨ Project directory successfully cleaned!${NC}"
else
    echo -e "\n${YELLOW}Cleanup aborted. No files were deleted.${NC}"
fi
