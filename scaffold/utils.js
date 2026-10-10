#!/usr/bin/env node
/**
 * utils.js - MagicalCoder LocalDev 公共工具模块
 *
 * 提供:
 * - 环境加载（.env）
 * - 登录和 Cookie 管理
 * - API 请求封装
 * - 文件压缩和解压
 * - 目录扫描
 * - UUID 生成
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const archiver = require('archiver');
const unzipper = require('unzipper');

/**
 * 加载 .env 文件（强制覆盖系统环境变量）
 */
function loadEnv() {
    const envFile = path.join(__dirname, '.env');
    if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf-8');
        envContent.split('\n').forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                // 强制覆盖环境变量
                process.env[key] = value;
            }
        });
    }
}

/**
 * 生成 UUID v4
 */
function generateUUID() {
    return crypto.randomUUID().replace(/-/g, '');
}

/**
 * 登录并获取 Cookie 文件路径
 */
function login(serverUrl, username, password, projectDir) {
    const cookiesFile = path.join(projectDir, '.cookies');
    const loginUrl = `${serverUrl}/youyaboot-admin/magical_lowcode/server/web/login`;

    try {
        // 注意：Windows 下 execSync 走 cmd.exe，不识别单引号，JSON body 必须用双引号 + \" 转义
        const cmd = `curl -s -c "${cookiesFile}" -X POST "${loginUrl}" -H "Content-Type: application/json" -d "{\\"userName\\":\\"${username}\\",\\"password\\":\\"${password}\\"}"`;
        const response = execSync(cmd, { encoding: 'utf-8' });

        if (response.includes('"code":0')) {
            return cookiesFile;
        } else {
            throw new Error(`登录失败: ${response}`);
        }
    } catch (error) {
        throw new Error(`登录失败: ${error.message}`);
    }
}

/**
 * 确保登录状态
 */
function ensureLogin(serverUrl, username, password, projectDir) {
    const cookiesFile = path.join(projectDir, '.cookies');

    // 检查 cookie 文件是否存在且有效
    if (fs.existsSync(cookiesFile)) {
        // 检查 cookie 是否过期（简单检查文件修改时间）
        const stats = fs.statSync(cookiesFile);
        const now = Date.now();
        const fileAge = now - stats.mtimeMs;

        // 如果 cookie 文件超过 1 小时，重新登录
        if (fileAge > 3600000) {
            return login(serverUrl, username, password, projectDir);
        }

        return cookiesFile;
    }

    return login(serverUrl, username, password, projectDir);
}

/**
 * 扫描目录下的所有 meta.json 文件
 */
function scanMetaFiles(dirPath, relativePath = '') {
    const results = [];

    if (!fs.existsSync(dirPath)) {
        return results;
    }

    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
            const metaFile = path.join(itemPath, 'meta.json');
            if (fs.existsSync(metaFile)) {
                try {
                    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
                    results.push({
                        id: meta.id,
                        name: meta.name,
                        path: path.join(relativePath, item),
                        dirPath: itemPath,
                        meta: meta
                    });
                } catch (error) {
                    console.warn(`⚠ 跳过无效 meta.json: ${metaFile}`);
                }
            }

            // 递归扫描子目录
            const childResults = scanMetaFiles(itemPath, path.join(relativePath, item));
            results.push(...childResults);
        }
    }

    return results;
}

/**
 * 扫描目录下的所有 page.json 文件
 */
function scanPageFiles(dirPath, relativePath = '') {
    const results = [];

    if (!fs.existsSync(dirPath)) {
        return results;
    }

    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
            const pageJsonPath = path.join(itemPath, 'page.json');

            if (fs.existsSync(pageJsonPath)) {
                try {
                    const pageData = JSON.parse(fs.readFileSync(pageJsonPath, 'utf-8'));
                    results.push({
                        uuid: pageData.uuid,
                        name: pageData.name,
                        path: path.join(relativePath, item),
                        dirPath: itemPath,
                        isDir: pageData.dir === true,
                        pageData: pageData
                    });
                } catch (error) {
                    console.warn(`⚠ 跳过无效 page.json: ${pageJsonPath}`);
                }
            }

            // 递归扫描子目录
            const childResults = scanPageFiles(itemPath, path.join(relativePath, item));
            results.push(...childResults);
        }
    }

    return results;
}

/**
 * 创建 ZIP 压缩包
 */
function createZip(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            resolve(outputPath);
        });

        archive.on('error', (err) => {
            reject(err);
        });

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

/**
 * 解压 ZIP 文件
 */
async function extractZip(zipPath, outputDir) {
    try {
        const pendingEntries = [];

        await new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(unzipper.Parse())
                .on('entry', (entry) => {
                    const filePath = path.join(outputDir, entry.path);
                    const directory = path.dirname(filePath);

                    if (!fs.existsSync(directory)) {
                        fs.mkdirSync(directory, { recursive: true });
                    }

                    if (entry.type === 'Directory') {
                        fs.mkdirSync(filePath, { recursive: true });
                        entry.autodrain();
                    } else {
                        const writeStream = fs.createWriteStream(filePath);
                        entry.pipe(writeStream);

                        // 跟踪每个文件写入完成
                        pendingEntries.push(new Promise((res) => {
                            writeStream.on('finish', res);
                            writeStream.on('error', res);
                        }));
                    }
                })
                .on('close', async () => {
                    // 等待所有文件写入完成
                    await Promise.all(pendingEntries);
                    resolve();
                })
                .on('error', reject);
        });
    } catch (error) {
        throw new Error(`解压失败: ${error.message}`);
    }
}

/**
 * 复制目录
 */
function copyDirectory(src, dest) {
    if (!fs.existsSync(src)) {
        return;
    }

    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }

    const items = fs.readdirSync(src);

    for (const item of items) {
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        const stat = fs.statSync(srcPath);

        if (stat.isDirectory()) {
            copyDirectory(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * 删除目录
 */
function deleteDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return;
    }

    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
            deleteDirectory(itemPath);
        } else {
            fs.unlinkSync(itemPath);
        }
    }

    fs.rmdirSync(dirPath);
}

/**
 * 解析命令行参数
 */
function parseArgs(args) {
    const result = {
        positional: [],
        options: {}
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('-')) {
            // 选项参数
            const key = arg.replace(/^-+/, '');
            const value = args[i + 1];

            if (value && !value.startsWith('-')) {
                result.options[key] = value;
                i++;
            } else {
                result.options[key] = true;
            }
        } else {
            // 位置参数
            result.positional.push(arg);
        }
    }

    return result;
}

/**
 * 生成时间戳（格式：2026-05-18 09:06:44）
 */
function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// 导出所有工具函数
module.exports = {
    loadEnv,
    generateUUID,
    login,
    ensureLogin,
    scanMetaFiles,
    scanPageFiles,
    createZip,
    extractZip,
    copyDirectory,
    deleteDirectory,
    parseArgs,
    getTimestamp
};
