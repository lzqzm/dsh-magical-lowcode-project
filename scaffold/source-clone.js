#!/usr/bin/env node
/**
 * source-pull.js - 从低代码平台拉取项目，生成项目目录
 *
 * 用法: node source-pull.js [project_uuid]
 *
 * 环境变量:
 *   SERVER_URL      - 服务器地址 (默认: http://localhost:8080)
 *   USERNAME       - 用户名
 *   PASSWORD       - 密码
 *   PULL_FILE      - 指定要拉取的文件类型（JSON数组格式）
 *                    可选值: 'page', 'api', 'database'
 *                    示例: PULL_FILE=[ 'page', 'api', 'database']
 *                    默认: 全部类型
 *
 * 示例:
 *   # 拉取所有文件
 *   node source-pull.js b4747eb2c1774212a4f54aa89d205dc9
 *
 *   # 只拉取页面
 *   # 在 .env 中配置: PULL_FILE=[ 'page']
 *   node source-pull.js b4747eb2c1774212a4f54aa89d205dc9
 *
 *   # 只拉取页面和API
 *   # 在 .env 中配置: PULL_FILE=[ 'page', 'api']
 *   node source-pull.js b4747eb2c1774212a4f54aa89d205dc9
 */

const { execSync } = require('child_process');
const path = require('path');

// 加载 .env 文件（强制覆盖系统环境变量）
function loadEnv() {
    const fs = require('fs');
    const envFile = path.join(__dirname, '.env');
    if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf-8');
        envContent.split('\n').forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                // 强制覆盖环境变量。
                // 注意：这里**不能**写成 if (!process.env[key]) —— Windows 自带一个
                // USERNAME 环境变量（当前登录账户名），「不覆盖」的话 .env 里的登录名
                // 会被它顶掉。utils.loadEnv() 也是强制覆盖的，两边语义必须一致。
                process.env[key] = value;
            }
        });
    }
}

loadEnv();

const PROJECT_UUID = process.argv[2] || process.env.PROJECT_UUID || '';

if (!PROJECT_UUID) {
    console.error('❌ 错误: 请提供项目UUID或配置 .env 中的 PROJECT_UUID');
    console.error('');
    console.error('用法:');
    console.error('  node source-pull.js <project_uuid>');
    console.error('  或在 .env 中配置 PROJECT_UUID 后直接运行:');
    console.error('  node source-pull.js');
    process.exit(1);
}

// 解析 PULL_FILE 配置，默认为全部类型
let PULL_FILE = ['page', 'api', 'database'];
if (process.env.PULL_FILE) {
    try {
        const envValue = process.env.PULL_FILE.trim();
        // 尝试使用 JSON.parse 解析（支持双引号）
        if (envValue.startsWith('[')) {
            try {
                const parsed = JSON.parse(envValue);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    PULL_FILE = parsed;
                }
            } catch (e) {
                // JSON 解析失败，尝试手动解析单引号格式
                const match = envValue.match(/\[([^\]]+)\]/);
                if (match) {
                    const items = match[1].split(',').map(s => {
                        s = s.trim();
                        // 移除单引号或双引号
                        s = s.replace(/^['"]|['"]$/g, '');
                        return s.trim();
                    }).filter(s => s);
                    if (items.length > 0) {
                        PULL_FILE = items;
                    }
                }
            }
        } else if (envValue.includes(',')) {
            // 支持逗号分隔的格式: page,api,database
            PULL_FILE = envValue.split(',').map(s => s.trim()).filter(s => s);
        }
    } catch (error) {
        console.warn('⚠ PULL_FILE 配置格式错误，使用默认值');
    }
}

function runScript(scriptName, args = []) {
    const scriptPath = path.join(__dirname, scriptName);
    const fullArgs = [scriptPath, ...args];

    console.log(`  执行: node ${scriptName} ${args.join(' ')}`);
    console.log('');

    try {
        execSync(`node "${scriptPath}" ${args.join(' ')}`, {
            stdio: 'inherit',
            cwd: __dirname
        });
        console.log('');
        return true;
    } catch (error) {
        console.error(`✗ ${scriptName} 执行失败`);
        return false;
    }
}

async function main() {
    console.log('========================================');
    console.log('  MagicalCoder Source Pull (Node.js)');
    console.log('========================================');
    console.log(`项目UUID:  ${PROJECT_UUID}`);
    // 只打印真会拉的：PULL_FILE 里没实现的类型（比如 component）以前照样列出来，
    // 看着像拉了，其实被静默跳过。
    const PULL_SUPPORTED = ['page', 'api', 'database'];
    const pullWanted = PULL_FILE.filter(t => PULL_SUPPORTED.includes(t));
    const pullIgnored = PULL_FILE.filter(t => PULL_SUPPORTED.includes(t) === false);
    console.log(`拉取类型:  ${pullWanted.join(', ')}`);
    if (pullIgnored.length > 0) {
        console.log(`⚠ 忽略:    ${pullIgnored.join(', ')}（这个脚本只拉 ${PULL_SUPPORTED.join(' / ')}）`);
    }
    console.log('========================================');
    console.log('');

    let allSuccess = true;
    // 拉取数据库
    if (PULL_FILE.includes('database')) {
        console.log('[3/?] 拉取数据库配置...');
        if (!runScript('source-db-pull.js', [PROJECT_UUID])) {
            allSuccess = false;
        }
    }
    // 拉取 API
    if (PULL_FILE.includes('api')) {
        console.log('[1/?] 拉取 API...');
        if (!runScript('source-api-pull.js', ['-a'])) {
            allSuccess = false;
        }
    }

    // 拉取页面
    if (PULL_FILE.includes('page')) {
        console.log('[2/?] 拉取页面...');
        if (!runScript('source-page-pull.js', ['-a'])) {
            allSuccess = false;
        }
    }

    console.log('========================================');
    if (allSuccess) {
        console.log('✅ 拉取成功!');
    } else {
        console.log('⚠ 部分拉取失败，请检查上面的错误信息');
    }
    console.log('========================================');
}

main();
