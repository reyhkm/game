const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const THREE = require('three');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

let players = {};
let orbs = [];
let planets = [];

const ORB_COUNT = 8;
const PLANET_COUNT = 8;
const WORLD_SIZE_SERVER = 220;

const PLAYER_MAX_HP = 100;
const PLAYER_RESPAWN_DELAY = 3000;
const SHOT_COOLDOWN = 150;
const SHOT_DAMAGE = 15;
const SHOT_RANGE = 200;
const PLAYER_SERVER_RADIUS = 2.5;
const KILL_SCORE_BONUS = 1;
const PROJECTILE_SERVER_LIFESPAN_MS = 1500;
const ORB_HEAL_AMOUNT = 25;

function generateOrbId() { return `orb-${Math.random().toString(36).substr(2, 9)}`; }
function spawnNewOrb() { const orbId = generateOrbId(); const newOrb = { id: orbId, x: (Math.random() - 0.5) * WORLD_SIZE_SERVER * 1.8, y: Math.random() * (WORLD_SIZE_SERVER * 0.7) + 5, z: (Math.random() - 0.5) * WORLD_SIZE_SERVER * 1.8, }; orbs.push(newOrb); io.emit('orbSpawned', newOrb); }
function initializeOrbs() { orbs = []; for (let i = 0; i < ORB_COUNT; i++) { spawnNewOrb(); } }

function initializePlanets() {
    planets = [];
    console.log("Server: Initializing planets...");
    const planetWithRingIndex = Math.floor(Math.random() * PLANET_COUNT);

    for (let i = 0; i < PLANET_COUNT; i++) {
        const radius = parseFloat((Math.random() * (60 - 25) + 25).toFixed(2));
        const colorHex = Math.floor(Math.random()*0xFFFFFF);
        let pos; let validPosition = false; let attempts = 0; const maxAttempts = 50;
        while (!validPosition && attempts < maxAttempts) {
            pos = { x: parseFloat(((Math.random() - 0.5) * WORLD_SIZE_SERVER * 1.6).toFixed(2)), y: parseFloat(((Math.random() - 0.5) * WORLD_SIZE_SERVER * 1.6).toFixed(2)), z: parseFloat(((Math.random() - 0.5) * WORLD_SIZE_SERVER * 1.6).toFixed(2)), };
            const distanceFromCenter = Math.sqrt(pos.x*pos.x + pos.y*pos.y + pos.z*pos.z);
            if (distanceFromCenter < WORLD_SIZE_SERVER * 0.4) { attempts++; continue; }
            validPosition = true;
            for (const existingPlanet of planets) {
                const dx = existingPlanet.x - pos.x; const dy = existingPlanet.y - pos.y; const dz = existingPlanet.z - pos.z;
                const distanceSquared = dx*dx + dy*dy + dz*dz;
                const minDistance = parseFloat(existingPlanet.radius) + radius + 30;
                if (distanceSquared < minDistance * minDistance) { validPosition = false; break; }
            }
            attempts++;
        }
        if (!validPosition) { pos = {x:0,y:0,z:0}; }

        const planetData = { id: `planet-${i}`, x: pos.x, y: pos.y, z: pos.z, radius: radius, color: colorHex, hasRing: false };
        if (i === planetWithRingIndex) {
            planetData.hasRing = true;
            planetData.ringMinRadius = radius + 5 + Math.random() * 5; // Jarak cincin dari planet
            planetData.ringMaxRadius = planetData.ringMinRadius + 10 + Math.random() * 15; // Lebar cincin
            planetData.ringThickness = 1 + Math.random() * 2; // Ketebalan cincin (untuk partikel)
        }
        planets.push(planetData);
    }
    console.log(`Server: Initialized ${planets.length} planets. Planet ${planetWithRingIndex} has a ring.`);
}

function getScoreboard() { return Object.values(players).map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, isAlive: p.isAlive })).sort((a, b) => b.kills - a.kills || b.name.localeCompare(a.name)); }

initializeOrbs();
initializePlanets();

io.on('connection', (socket) => {
    socket.on('playerInit', (data) => {
        const playerName = data.name ? data.name.substring(0, 15) : `Pilot_${socket.id.substring(0,4)}`;
        players[socket.id] = { id: socket.id, name: playerName, x: 0, y: 5, z: 0, yaw: 0, pitch: 0, hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, isAlive: true, lastShotTime: 0, kills: 0, deaths: 0, };
        console.log(`Server: Player initialized - ID: ${socket.id}, Name: '${playerName}'`);
        socket.emit('currentGameState', { players, orbs, planets, myId: socket.id });
        socket.broadcast.emit('playerJoined', players[socket.id]);
        io.emit('updateScoreboard', getScoreboard());
    });

    socket.on('playerStateUpdate', (data) => { const player = players[socket.id]; if (player && player.isAlive) { player.x = data.x; player.y = data.y; player.z = data.z; player.yaw = data.yaw; player.pitch = data.pitch; socket.broadcast.emit('playerMoved', player); } });

    socket.on('playerShoot', (shotData) => {
        const shooter = players[socket.id];
        if (!shooter || !shooter.isAlive || Date.now() - shooter.lastShotTime < SHOT_COOLDOWN) { return; }
        shooter.lastShotTime = Date.now();
        const shooterPosition = new THREE.Vector3(shooter.x, shooter.y, shooter.z);
        const shotDirection = new THREE.Vector3(0, 0, 1);
        shotDirection.applyQuaternion(new THREE.Quaternion( shotData.orientation._x, shotData.orientation._y, shotData.orientation._z, shotData.orientation._w ));
        shotDirection.normalize();
        const projectileId = `proj-${socket.id}-${Date.now()}`;
        io.emit('projectileFired', { shooterId: shooter.id, projectileId: projectileId, startPosition: shotData.startPosition, orientation: shotData.orientation, lifespan: PROJECTILE_SERVER_LIFESPAN_MS / 1000 });
        const ray = new THREE.Ray(new THREE.Vector3(shotData.startPosition.x, shotData.startPosition.y, shotData.startPosition.z), shotDirection);
        let hitPlayer = null; let minDistance = SHOT_RANGE + 1;
        for (const targetId in players) {
            if (targetId === socket.id || !players[targetId].isAlive) continue;
            const target = players[targetId];
            const targetPosition = new THREE.Vector3(target.x, target.y, target.z);
            const sphere = new THREE.Sphere(targetPosition, PLAYER_SERVER_RADIUS);
            const intersectionPoint = new THREE.Vector3();
            if (ray.intersectSphere(sphere, intersectionPoint)) {
                const distanceToHit = shooterPosition.distanceTo(intersectionPoint);
                if (distanceToHit <= SHOT_RANGE && distanceToHit < minDistance) { minDistance = distanceToHit; hitPlayer = target; }
            }
        }
        if (hitPlayer) {
            hitPlayer.hp -= SHOT_DAMAGE;
            const damageSourcePosition = {x: shooter.x, y: shooter.y, z: shooter.z};
            io.emit('playerDamaged', { playerId: hitPlayer.id, newHp: hitPlayer.hp, attackerId: shooter.id, shotImpactPosition: ray.at(minDistance, new THREE.Vector3()), damageSourcePosition: damageSourcePosition });
            if (hitPlayer.hp <= 0) {
                shooter.kills++; hitPlayer.deaths++; hitPlayer.isAlive = false;
                const killerName = shooter.name; const victimName = hitPlayer.name;
                io.emit('playerDied', { playerId: hitPlayer.id, killerId: shooter.id, killerName: killerName, victimName: victimName, deathPosition: { x: hitPlayer.x, y: hitPlayer.y, z: hitPlayer.z } });
                io.emit('globalDeathNotification', { victimName: victimName, killerName: killerName });
                io.emit('updateScoreboard', getScoreboard());
                setTimeout(() => { if (players[hitPlayer.id]) { players[hitPlayer.id].isAlive = true; players[hitPlayer.id].hp = PLAYER_MAX_HP; players[hitPlayer.id].x = (Math.random() - 0.5) * 50; players[hitPlayer.id].y = 5; players[hitPlayer.id].z = (Math.random() - 0.5) * 50; players[hitPlayer.id].yaw = 0; players[hitPlayer.id].pitch = 0; io.emit('playerRespawned', players[hitPlayer.id]); io.emit('updateScoreboard', getScoreboard()); } }, PLAYER_RESPAWN_DELAY);
            }
        }
    });

    socket.on('playerHitPlanet', ({ planetId }) => {
        const player = players[socket.id]; const planet = planets.find(p => p.id === planetId);
        if (!player || !player.isAlive || !planet) return;
        const dx = player.x - planet.x; const dy = player.y - planet.y; const dz = player.z - planet.z;
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (distance < planet.radius + PLAYER_SERVER_RADIUS * 1.2) { // Kurangi toleransi sedikit
            player.deaths++; player.isAlive = false; player.hp = 0;
            const victimName = player.name;
            io.emit('playerDied', { playerId: player.id, killerId: null, killerName: "Planet", victimName: victimName, deathPosition: { x: player.x, y: player.y, z: player.z } });
            io.emit('globalDeathNotification', { victimName: victimName, killerName: "Planet" });
            io.emit('updateScoreboard', getScoreboard());
            setTimeout(() => { if (players[player.id]) { players[player.id].isAlive = true; players[player.id].hp = PLAYER_MAX_HP; players[player.id].x = (Math.random() - 0.5) * 50; players[player.id].y = 5; players[player.id].z = (Math.random() - 0.5) * 50; players[player.id].yaw = 0; players[player.id].pitch = 0; io.emit('playerRespawned', players[player.id]); io.emit('updateScoreboard', getScoreboard()); } }, PLAYER_RESPAWN_DELAY);
        }
    });

    socket.on('orbCollected', (orbId) => { const player = players[socket.id]; if (player && player.isAlive) { const orbIndex = orbs.findIndex(orb => orb.id === orbId); if (orbIndex !== -1) { orbs.splice(orbIndex, 1)[0]; player.hp = Math.min(player.maxHp, player.hp + ORB_HEAL_AMOUNT); io.emit('playerHealed', { playerId: socket.id, newHp: player.hp, orbId: orbId }); spawnNewOrb(); } } });
    socket.on('disconnect', () => { if(players[socket.id]){ console.log(`Server: Player left - ID: ${socket.id}, Name: '${players[socket.id].name}'`); delete players[socket.id]; io.emit('playerLeft', socket.id); io.emit('updateScoreboard', getScoreboard()); } });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server Cosmic Voyager Multiplayer berjalan di http://localhost:${PORT}`); });