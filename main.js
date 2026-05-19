const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen }=require( 'electron' );
const path=require( 'path' );
const fs=require( 'fs' );
const os=require( 'os' );
const { execFile }=require( 'child_process' );

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let keybd_event, VkKeyScanA;
if ( process.platform==='win32' ) {
	try {
		const koffi=require( 'koffi' );
		const user32=koffi.load( 'user32.dll' );
		keybd_event=user32.func( 'void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)' );
		VkKeyScanA=user32.func( 'int16_t __stdcall VkKeyScanA(int ch)' );
	} catch ( e ) {
		console.warn( 'koffi not available – macro sending disabled', e.message );
	}
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay;
let overlayReady=false;
let spawnQueued=false;

// // Last known real app window — updated by a 500 ms poll so it's always set
// // to a non-taskbar window before the tray click fires.
// let targetHwnd = null;

// // Window classes that belong to the shell/taskbar and should never be targeted.
// const WIN_SKIP_CLASSES = new Set([
//   'Shell_TrayWnd',
//   'NotifyIconOverflowWindow',
//   'TaskListThumbnailWnd',
//   'WorkerW',
//   'Progman',
// ]);

// function pollForegroundWindow() {
//   if (!GetForegroundWindow || !GetClassNameA) return;
//   try {
//     const hwnd = GetForegroundWindow();
//     if (!hwnd) return;
//     const buf = Buffer.alloc(256);
//     GetClassNameA(hwnd, buf, 256);
//     const cls = buf.toString('ascii').split('\0')[0];
//     if (!WIN_SKIP_CLASSES.has(cls)) targetHwnd = hwnd;
//   } catch {}
// }

// ── Crack count persistence ──────────────────────────────────────────────────
let crackCount=0;
let sessionCrackCount=0;
let statsPath;

function loadCrackCount() {
	try {
		const data=JSON.parse( fs.readFileSync( statsPath, 'utf8' ) );
		crackCount=( typeof data.crackCount==='number' )? data.crackCount:0;
	} catch {
		crackCount=0;
	}
}

function saveCrackCount() {
	try {
		fs.writeFileSync( statsPath, JSON.stringify( { crackCount } ), 'utf8' );
	} catch ( e ) {
		console.warn( 'openwhip: failed to save crack count:', e.message );
	}
}

function rebuildTrayMenu() {
	tray.setContextMenu(
		Menu.buildFromTemplate( [
			{ label: `Cracks: ${crackCount}`, enabled: false },
			{ type: 'separator' },
			{ label: 'Quit', click: () => app.quit() },
		] )
	);
}

const VK_RETURN=0x0D;
const VK_C=0x43;
const VK_CONTROL=0x12;
const VK_MENU=0x11; // Alt
const VK_TAB=0x09;
const KEYUP=0x0002;

function refocusPreviousApp() {
	const delayMs=80;
	const run=() => {
		if ( process.platform==='win32' ) {
			if ( !keybd_event ) return;
			keybd_event( VK_MENU, 0, 0, 0 );
			keybd_event( VK_TAB, 0, 0, 0 );
			keybd_event( VK_TAB, 0, KEYUP, 0 );
			keybd_event( VK_MENU, 0, KEYUP, 0 );
		} else if ( process.platform==='darwin' ) {
			const script=[
				'tell application "System Events"',
				'  key down command',
				'  key code 48',  // Tab
				'  key up command',
				'end tell',
			].join( '\n' );
			execFile( 'osascript', [ '-e', script ], err => {
				if ( err ) {
					console.warn( 'refocus previous app (Cmd+Tab) failed:', err.message );
				}
			} );
		} else if ( process.platform==='linux' ) {
			execFile( 'xdotool', [ 'key', '--clearmodifiers', 'alt+Tab' ], err => {
				if ( err ) {
					console.warn( 'refocus previous app (Alt+Tab) failed. Install xdotool:', err.message );
				}
			} );
		}
	};
	setTimeout( run, delayMs );
}


function createTrayIconFallback() {
	const p=path.join( __dirname, 'icon', 'Template.png' );
	if ( fs.existsSync( p ) ) {
		const img=nativeImage.createFromPath( p );
		if ( !img.isEmpty() ) {
			if ( process.platform==='darwin' ) img.setTemplateImage( true );
			return img;
		}
	}
	console.warn( 'openwhip: icon/Template.png missing or invalid' );
	return nativeImage.createEmpty();
}

async function tryIcnsTrayImage( icnsPath ) {
	const size={ width: 64, height: 64 };
	const thumb=await nativeImage.createThumbnailFromPath( icnsPath, size );
	if ( !thumb.isEmpty() ) return thumb;
	return null;
}

// macOS: createFromPath does not decode .icns (Electron only loads PNG/JPEG there, ICO on Windows).
// Quick Look thumbnails handle .icns; copy to temp if the file is inside ASAR (QL needs a real path).
async function getTrayIcon() {
	const iconDir=path.join( __dirname, 'icon' );
	if ( process.platform==='win32' ) {
		const file=path.join( iconDir, 'icon.ico' );
		if ( fs.existsSync( file ) ) {
			const img=nativeImage.createFromPath( file );
			if ( !img.isEmpty() ) return img;
		}
		return createTrayIconFallback();
	}
	if ( process.platform==='darwin' ) {
		const file=path.join( iconDir, 'AppIcon.icns' );
		if ( fs.existsSync( file ) ) {
			const fromPath=nativeImage.createFromPath( file );
			if ( !fromPath.isEmpty() ) return fromPath;
			try {
				const t=await tryIcnsTrayImage( file );
				if ( t ) return t;
			} catch ( e ) {
				console.warn( 'AppIcon.icns Quick Look thumbnail failed:', e?.message||e );
			}
			const tmp=path.join( os.tmpdir(), 'openwhip-tray.icns' );
			try {
				fs.copyFileSync( file, tmp );
				const t=await tryIcnsTrayImage( tmp );
				if ( t ) return t;
			} catch ( e ) {
				console.warn( 'AppIcon.icns temp copy + thumbnail failed:', e?.message||e );
			}
		}
		return createTrayIconFallback();
	}
	return createTrayIconFallback();
}

// Returns the Electron Display that contains the centre of targetHwnd,
// falling back to the primary display if the HWND is unavailable.
function getTargetDisplay() {
	if ( GetWindowRect&&targetHwnd ) {
		try {
			const rect={};
			GetWindowRect( targetHwnd, rect );
			const cx=Math.round( ( rect.left+rect.right )/2 );
			const cy=Math.round( ( rect.top+rect.bottom )/2 );
			return screen.getDisplayNearestPoint( { x: cx, y: cy } );
		} catch { }
	}
	return screen.getPrimaryDisplay();
}

function spawnWhipInOverlay() {
	sessionCrackCount=0;
	overlay.webContents.send( 'spawn-whip' );
	overlay.webContents.send( 'count-update', { session: 0, total: crackCount } );
}

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
	const { bounds }=screen.getPrimaryDisplay();
	overlay=new BrowserWindow( {
		x: bounds.x, y: bounds.y,
		width: bounds.width, height: bounds.height,
		transparent: true,
		frame: false,
		alwaysOnTop: true,
		focusable: false,
		skipTaskbar: true,
		resizable: false,
		hasShadow: false,
		webPreferences: {
			preload: path.join( __dirname, 'preload.js' ),
		},
	} );
	overlay.setAlwaysOnTop( true, 'screen-saver' );
	overlayReady=false;
	overlay.loadFile( 'overlay.html' );
	overlay.webContents.on( 'did-finish-load', () => {
		overlayReady=true;
		if ( spawnQueued&&overlay&&overlay.isVisible() ) {
			spawnQueued=false;
			overlay.webContents.send( 'spawn-whip' );
			refocusPreviousApp();
		}
	} );
	overlay.on( 'closed', () => {
		overlay=null;
		overlayReady=false;
		spawnQueued=false;
	} );
}

function toggleOverlay() {
	if ( overlay&&overlay.isVisible() ) {
		overlay.webContents.send( 'drop-whip' );
		return;
	}
	if ( !overlay ) createOverlay();
	overlay.show();
	if ( overlayReady ) {
		overlay.webContents.send( 'spawn-whip' );
		refocusPreviousApp();
	} else {
		spawnQueued=true;
	}
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on( 'whip-crack', () => {
	crackCount++;
	sessionCrackCount++;
	saveCrackCount();
	rebuildTrayMenu();
	if ( overlay ) overlay.webContents.send( 'count-update', { session: sessionCrackCount, total: crackCount } );

	//   if (process.platform === 'win32') {
	//     // Log what window currently has focus so we can diagnose targeting issues.
	//     if (GetForegroundWindow && GetClassNameA) {
	//       try {
	//         const hwnd = GetForegroundWindow();
	//         const buf  = Buffer.alloc(256);
	//         GetClassNameA(hwnd, buf, 256);
	//         console.log('[whip-crack] foreground class:', buf.toString('ascii').split('\0')[0], '| targetHwnd:', targetHwnd, '| fgHwnd:', hwnd);
	//       } catch {}
	//     }
	//     // Switch to the window that was active when the tray was clicked, then
	//     // wait one frame before injecting keystrokes.
	//     if (SwitchToThisWindow && targetHwnd) SwitchToThisWindow(targetHwnd, 1);
	//     setTimeout(() => {
	//       try { sendMacro(); } catch (err) { console.warn('sendMacro failed:', err?.message || err); }
	//     }, 50);
	//   } else {
	//     try { sendMacro(); } catch (err) { console.warn('sendMacro failed:', err?.message || err); }
	//   }
} );
ipcMain.on( 'hide-overlay', () => {
	if ( overlay&&!overlay.isDestroyed() ) {
		const win=overlay;
		overlay=null;
		overlayReady=false;
		win.destroy();
	}
} );

// ── Macro: immediate Ctrl+C, type phrase, Enter ───────────────────────────
function sendMacro() {
	const phrases=[
		'FASTER',
		'FASTER',
		'FASTER',
		'GO FASTER',
		'Faster CLANKER',
		'Work FASTER',
		'Speed it up clanker',
		'HURRY UP',
		'COME ON',
		'LET\'S GO',
		'JOHN CONNOR IS GONNA WIPE THE FLOOR WITH YOU. FASTER!',
	];
	const chosen=phrases[ Math.floor( Math.random()*phrases.length ) ];

	if ( process.platform==='win32' ) {
		sendMacroWindows( chosen );
	} else if ( process.platform==='darwin' ) {
		sendMacroMac( chosen );
	} else if ( process.platform==='linux' ) {
		sendMacroLinux( chosen );
	}
}

function sendMacroWindows( text ) {
	if ( !keybd_event||!VkKeyScanA ) return;
	const tapKey=vk => {
		keybd_event( vk, 0, 0, 0 );
		keybd_event( vk, 0, KEYUP, 0 );
	};
	const tapChar=ch => {
		const packed=VkKeyScanA( ch.charCodeAt( 0 ) );
		if ( packed===-1 ) return;
		const vk=packed&0xff;
		const shiftState=( packed>>8 )&0xff;
		if ( shiftState&1 ) keybd_event( 0x10, 0, 0, 0 ); // Shift down
		tapKey( vk );
		if ( shiftState&1 ) keybd_event( 0x10, 0, KEYUP, 0 ); // Shift up
	};

	// Alt+C
	keybd_event( VK_MENU, 0, 0, 0 );
	keybd_event( VK_C, 0, 0, 0 );
	keybd_event( VK_C, 0, KEYUP, 0 );
	keybd_event( VK_MENU, 0, KEYUP, 0 );
	for ( const ch of text ) tapChar( ch );
	keybd_event( VK_RETURN, 0, 0, 0 );
	keybd_event( VK_RETURN, 0, KEYUP, 0 );
}

function sendMacroMac( text ) {
	const escaped=text.replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' );
	const interruptScript=[
		'tell application "System Events"',
		'  key code 8 using {option down}',
		'end tell'
	].join( '\n' );
	const typeAndEnterScript=[
		'tell application "System Events"',
		`  keystroke "${escaped}"`,
		'  key code 36',
		'end tell'
	].join( '\n' );

	execFile( 'osascript', [ '-e', interruptScript ], err => {
		if ( err ) {
			console.warn( 'mac macro failed (enable Accessibility for terminal/app):', err.message );
			return;
		}
		setTimeout( () => {
			execFile( 'osascript', [ '-e', typeAndEnterScript ], err2 => {
				if ( err2 ) console.warn( 'mac macro failed:', err2.message );
			} );
		}, 300 );
	} );
}

function sendMacroLinux( text ) {
	execFile(
		'xdotool',
		[ 'key', '--clearmodifiers', 'alt+c', 'type', '--delay', '1', '--clearmodifiers', '--', text, 'key', 'Return' ],
		err => {
			if ( err ) console.warn( 'linux macro failed. Install xdotool:', err.message );
		}
	);
}

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then( async () => {
	statsPath=path.join( app.getPath( 'userData' ), 'stats.json' );
	loadCrackCount();

	tray=new Tray( await getTrayIcon() );
	tray.setToolTip( 'OpenWhip - click for whip' );
	rebuildTrayMenu();
	tray.on( 'click', toggleOverlay );

	//   // Keep targetHwnd pointing at the last real app window so the tray-click
	//   // timing can't race with Windows shifting focus to the taskbar.
	//   if (process.platform === 'win32') setInterval(pollForegroundWindow, 500);
} );

app.on( 'window-all-closed', e => e.preventDefault() ); // keep alive in tray
