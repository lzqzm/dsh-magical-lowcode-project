#!/usr/bin/env node
/**
 * source-db-pull.js - 从线上拉取数据库配置（完全覆盖本地）
 *
 * 用法: node source-db-pull.js [project_uuid]
 *
 * 环境变量:
 *   SERVER_URL   - 服务器地址 (默认: http://localhost:8080)
 *   USERNAME     - 用户名
 *   PASSWORD     - 密码
 *
 * 示例:
 *   node source-db-pull.js b4747eb2c1774212a4f54aa89d205dc9
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const unzipper = require('unzipper');

// 加载 .env 文件（强制覆盖系统环境变量）
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

loadEnv();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const PROJECT_UUID = process.argv[2] || process.env.PROJECT_UUID || '';
const USERNAME = process.env.USERNAME || '';
const PASSWORD = process.env.PASSWORD || '';

if (!PROJECT_UUID) {
    console.error('❌ 错误: 请提供项目UUID或配置 .env 中的 PROJECT_UUID');
    console.error('');
    console.error('用法:');
    console.error('  node source-db-pull.js <project_uuid>');
    console.error('  或在 .env 中配置 PROJECT_UUID 后直接运行:');
    console.error('  node source-db-pull.js');
    process.exit(1);
}

const OUTPUT_DIR = path.join(__dirname, PROJECT_UUID);
const DATABASES_DIR = path.join(OUTPUT_DIR, 'databases');

// Cookie 存储
let cookieString = '';

async function login() {
    console.log('[1/4] 登录获取授权...');
    const loginUrl = `${SERVER_URL}/youyaboot-admin/magical_lowcode/server/web/login`;

    try {
        const response = await axios.post(loginUrl, {
            userName: USERNAME,
            password: PASSWORD
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // 从响应头中提取 cookie
        const setCookie = response.headers['set-cookie'];
        if (setCookie && Array.isArray(setCookie)) {
            cookieString = setCookie.map(c => c.split(';')[0]).join('; ');
        }

        if (response.data && (response.data.code === 0 || response.data.flag === true)) {
            console.log('✓ 登录成功');
            return true;
        } else {
            console.error(`✗ 登录失败: ${JSON.stringify(response.data)}`);
            return false;
        }
    } catch (error) {
        console.error(`✗ 登录失败: ${error.message}`);
        return false;
    }
}

async function downloadProject() {
    console.log('');
    console.log('[2/4] 从服务器下载项目...');

    const zipPath = path.join(OUTPUT_DIR, `.temp-db-${Date.now()}.zip`);
    // 下载完整项目（包含 database）
    const downloadUrl = `${SERVER_URL}/youyaboot-admin/magicalcoder/user/project/local-export?projectUuid=${PROJECT_UUID}&includeTypes=database`;

    console.log(`下载URL: ${downloadUrl}`);

    try {
        const response = await axios({
            method: 'get',
            url: downloadUrl,
            headers: {
                'Cookie': cookieString
            },
            responseType: 'arraybuffer'
        });

        if (!response.data || response.data.length === 0) {
            console.error('✗ 下载失败: 返回为空');
            return null;
        }

        fs.writeFileSync(zipPath, response.data);

        const fileSize = response.data.length;
        const fileSizeStr = fileSize > 1024 * 1024
            ? `${(fileSize / 1024 / 1024).toFixed(2)} MB`
            : `${(fileSize / 1024).toFixed(2)} KB`;
        console.log(`✓ 项目已下载: ${fileSizeStr}`);
        return zipPath;
    } catch (error) {
        console.error(`✗ 下载失败: ${error.message}`);
        return null;
    }
}

async function extractAndProcessDatabases(zipPath) {
    console.log('');
    console.log('[3/4] 解压并处理数据库配置...');

    const extractDir = path.join(OUTPUT_DIR, `.temp-extract-db-${Date.now()}`);

    try {
        fs.mkdirSync(extractDir, { recursive: true });

        // 使用 unzipper 解压
        const pendingEntries = [];

        await new Promise((resolve, reject) => {
            fs.createReadStream(zipPath)
                .pipe(unzipper.Parse())
                .on('entry', (entry) => {
                    const filePath = path.join(extractDir, entry.path);
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

                        pendingEntries.push(new Promise((res) => {
                            writeStream.on('finish', res);
                            writeStream.on('error', res);
                        }));
                    }
                })
                .on('close', async () => {
                    await Promise.all(pendingEntries);
                    resolve();
                })
                .on('error', reject);
        });

        // 查找解压后的 databases 目录
        let onlineDatabasesDir = null;

        // 先在根目录查找 databases
        const rootItems = fs.readdirSync(extractDir);
        for (const item of rootItems) {
            const itemPath = path.join(extractDir, item);
            if (fs.statSync(itemPath).isDirectory() && item === 'databases') {
                onlineDatabasesDir = itemPath;
                break;
            }
        }

        // 如果根目录没有，在子目录中查找
        if (!onlineDatabasesDir) {
            for (const item of rootItems) {
                const itemPath = path.join(extractDir, item);
                if (fs.statSync(itemPath).isDirectory()) {
                    const subItems = fs.readdirSync(itemPath);
                    for (const subItem of subItems) {
                        const subPath = path.join(itemPath, subItem);
                        if (fs.statSync(subPath).isDirectory() && subItem === 'databases') {
                            onlineDatabasesDir = subPath;
                            break;
                        }
                    }
                }
                if (onlineDatabasesDir) break;
            }
        }

        if (!onlineDatabasesDir) {
            console.log('  ⚠ 未找到 databases 目录');
            console.log('  调试: 解压后的目录结构:');
            printDirTree(extractDir, '');
            return true;
        }

        console.log(`  调试: 找到 databases 目录: ${onlineDatabasesDir}`);

        // 处理数据库配置
        const tempProcessed = await processDatabasesJson(onlineDatabasesDir);

        // 删除旧的 databases 目录
        if (fs.existsSync(DATABASES_DIR)) {
            await deleteDirectoryRecursive(DATABASES_DIR);
        }

        // 重新创建并写入新的结构
        if (tempProcessed && tempProcessed.length > 0) {
            fs.mkdirSync(DATABASES_DIR, { recursive: true });
            for (const { dbName, tables } of tempProcessed) {
                const dbSubDir = path.join(DATABASES_DIR, dbName);
                fs.mkdirSync(dbSubDir, { recursive: true });
                for (const { tableName, tableData } of tables) {
                    const tableFilePath = path.join(dbSubDir, `${tableName}.json`);
                    fs.writeFileSync(tableFilePath, JSON.stringify(tableData, null, 2), 'utf-8');
                }
            }
            console.log(`✓ 处理了 ${tempProcessed.length} 个数据库配置`);
            console.log(`✓ 生成了 ${tempProcessed.reduce((sum, db) => sum + db.tables.length, 0)} 个表文件`);
        } else {
            console.log('  ⚠ 未找到数据库配置');
        }

        // 清理临时目录
        await deleteDirectoryRecursive(extractDir);

        console.log('✓ 处理完成');
        return true;
    } catch (error) {
        console.error(`✗ 处理失败: ${error.message}`);
        return false;
    }
}

// 打印目录树（用于调试）
function printDirTree(dir, prefix) {
    if (!fs.existsSync(dir)) return;

    const items = fs.readdirSync(dir);
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemPath = path.join(dir, item);
        const stat = fs.statSync(itemPath);
        const isLast = i === items.length - 1;

        console.log(`  ${prefix}${isLast ? '└── ' : '├── '}${item}${stat.isDirectory() ? '/' : ''}`);

        if (stat.isDirectory()) {
            printDirTree(itemPath, prefix + (isLast ? '    ' : '│   '));
        }
    }
}

async function deleteDirectoryRecursive(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return;
    }

    const items = fs.readdirSync(dirPath);
    for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
            await deleteDirectoryRecursive(itemPath);
        } else {
            fs.unlinkSync(itemPath);
        }
    }

    fs.rmdirSync(dirPath);
}

async function processDatabasesJson(databasesDir) {
    if (!fs.existsSync(databasesDir)) {
        return [];
    }

    const items = fs.readdirSync(databasesDir);
    const processed = [];

    for (const item of items) {
        const itemPath = path.join(databasesDir, item);

        if (path.extname(item) === '.json') {
            try {
                const dbData = JSON.parse(fs.readFileSync(itemPath, 'utf-8'));

                const dbName = dbData.name || path.basename(item, '.json');
                const tables = [];

                if (dbData.children && Array.isArray(dbData.children)) {
                    for (const child of dbData.children) {
                        const tableName = child.name || child.uuid;
                        tables.push({ tableName, tableData: child });
                    }
                }

                processed.push({ dbName, tables });
            } catch (error) {
                console.log(`  ⚠ 跳过无效数据库配置: ${item}`);
            }
        }
    }

    return processed;
}

async function main() {
    console.log('========================================');
    console.log('  拉取数据库配置 (完全覆盖本地)');
    console.log('========================================');
    console.log(`服务器地址: ${SERVER_URL}`);
    console.log(`项目UUID:  ${PROJECT_UUID}`);
    console.log(`输出目录:  ${OUTPUT_DIR}`);
    console.log('========================================');
    console.log('');

    try {
        // 确保目录存在
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        // 步骤 1: 登录
        const loginSuccess = await login();
        if (!loginSuccess) {
            process.exit(1);
        }

        // 步骤 2: 下载项目
        const zipPath = await downloadProject();
        if (!zipPath) {
            process.exit(1);
        }

        // 步骤 3: 解压并处理
        const success = await extractAndProcessDatabases(zipPath);
        if (!success) {
            if (fs.existsSync(zipPath)) {
                fs.unlinkSync(zipPath);
            }
            process.exit(1);
        }

        // 步骤 4: 清理 ZIP 文件
        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
        }

        console.log('');
        console.log('========================================');
        console.log('✅ 拉取成功!');
        console.log('========================================');
        console.log('');
        console.log(`数据库配置已保存到: ${DATABASES_DIR}`);
        console.log('');

    } catch (error) {
        console.error('');
        console.error('❌ 执行出错:', error.message);
        process.exit(1);
    }
}

main();
