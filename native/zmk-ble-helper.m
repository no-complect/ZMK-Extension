// zmk-ble-helper — CoreBluetooth subprocess for ZMK Studio VS Code extension.
//
// Protocol (newline-delimited JSON on stdin/stdout):
//   Helper → Host:
//     {"type":"devices","list":[{"id":"UUID","name":"Name"},…]}
//     {"type":"connected","name":"Name"}
//     {"type":"data","bytes":[0,1,2,…]}
//     {"type":"error","message":"…"}
//     {"type":"disconnected"}
//   Host → Helper:
//     {"cmd":"connect","id":"UUID"}
//     {"cmd":"write","bytes":[0,1,2,…]}
//     {"cmd":"disconnect"}
//
// Compile:
//   clang -fobjc-arc -framework CoreBluetooth -framework Foundation \
//         -o bin/zmk-ble-helper native/zmk-ble-helper.m

#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>

static CBUUID *ZMK_SERVICE_UUID;
static CBUUID *ZMK_RPC_CHRC_UUID;

// ── JSON output ───────────────────────────────────────────────────────────────

static void sendJSON(NSDictionary *dict) {
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:dict options:0 error:&err];
    if (!data) { return; }
    NSMutableData *line = [data mutableCopy];
    uint8_t nl = '\n';
    [line appendBytes:&nl length:1];
    [[NSFileHandle fileHandleWithStandardOutput] writeData:line];
}

// ── BLE Helper ────────────────────────────────────────────────────────────────

@interface BLEHelper : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
@property (nonatomic, strong) CBCentralManager *central;
@property (nonatomic, strong) CBPeripheral *connectedPeripheral;
@property (nonatomic, strong) CBCharacteristic *rpcCharacteristic;
@property (nonatomic, strong) NSMutableDictionary<NSString *, CBPeripheral *> *discovered;
@end

@implementation BLEHelper

- (instancetype)init {
    self = [super init];
    if (self) {
        _discovered = [NSMutableDictionary dictionary];
        _central = [[CBCentralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()];
    }
    return self;
}

// MARK: - CBCentralManagerDelegate — state

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    switch (central.state) {
        case CBManagerStatePoweredOn:
            [self discover];
            break;
        case CBManagerStateUnauthorized:
            sendJSON(@{@"type": @"error", @"message": @"Bluetooth access denied — check System Settings > Privacy > Bluetooth"});
            exit(1);
        case CBManagerStateUnsupported:
            sendJSON(@{@"type": @"error", @"message": @"Bluetooth is not supported on this machine"});
            exit(1);
        case CBManagerStatePoweredOff:
            sendJSON(@{@"type": @"error", @"message": @"Bluetooth is powered off"});
            exit(1);
        default:
            break;
    }
}

- (void)discover {
    // Step 1: find peripherals already connected to the system (bonded + connected to macOS).
    NSArray<CBPeripheral *> *bonded = [self.central retrieveConnectedPeripheralsWithServices:@[ZMK_SERVICE_UUID]];
    for (CBPeripheral *p in bonded) {
        self.discovered[p.identifier.UUIDString] = p;
    }

    if (bonded.count > 0) {
        [self reportDevices];
        return;
    }

    // Step 2: active scan for advertising devices.
    [self.central scanForPeripheralsWithServices:@[ZMK_SERVICE_UUID] options:nil];

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (!self.connectedPeripheral) {
            if (self.discovered.count == 0) {
                sendJSON(@{@"type": @"error", @"message": @"No ZMK keyboards found nearby (scan timed out)"});
                exit(1);
            }
            [self.central stopScan];
        }
    });
}

- (void)reportDevices {
    NSMutableArray *list = [NSMutableArray array];
    for (CBPeripheral *p in self.discovered.allValues) {
        NSString *name = p.name ?: p.identifier.UUIDString;
        [list addObject:@{@"id": p.identifier.UUIDString, @"name": name}];
    }
    sendJSON(@{@"type": @"devices", @"list": list});
}

// MARK: - CBCentralManagerDelegate — scan

- (void)centralManager:(CBCentralManager *)central
  didDiscoverPeripheral:(CBPeripheral *)peripheral
      advertisementData:(NSDictionary<NSString *, id> *)advertisementData
                   RSSI:(NSNumber *)RSSI {
    NSString *id = peripheral.identifier.UUIDString;
    if (!self.discovered[id]) {
        self.discovered[id] = peripheral;
        [central stopScan];
        [self reportDevices];
    }
}

// MARK: - CBCentralManagerDelegate — connection

- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
    [peripheral discoverServices:@[ZMK_SERVICE_UUID]];
}

- (void)centralManager:(CBCentralManager *)central
    didFailToConnectPeripheral:(CBPeripheral *)peripheral
                         error:(NSError *)error {
    NSString *msg = error ? error.localizedDescription : @"unknown error";
    sendJSON(@{@"type": @"error", @"message": [NSString stringWithFormat:@"Failed to connect: %@", msg]});
    exit(1);
}

- (void)centralManager:(CBCentralManager *)central
    didDisconnectPeripheral:(CBPeripheral *)peripheral
                      error:(NSError *)error {
    sendJSON(@{@"type": @"disconnected"});
    exit(0);
}

// MARK: - CBPeripheralDelegate — service / characteristic discovery

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
    if (error) {
        sendJSON(@{@"type": @"error", @"message": [NSString stringWithFormat:@"Service discovery failed: %@", error.localizedDescription]});
        exit(1);
    }
    CBService *svc = nil;
    for (CBService *s in peripheral.services) {
        if ([s.UUID isEqual:ZMK_SERVICE_UUID]) { svc = s; break; }
    }
    if (!svc) {
        sendJSON(@{@"type": @"error", @"message": @"ZMK service not found on device"});
        exit(1);
    }
    [peripheral discoverCharacteristics:@[ZMK_RPC_CHRC_UUID] forService:svc];
}

- (void)peripheral:(CBPeripheral *)peripheral
    didDiscoverCharacteristicsForService:(CBService *)service
                                   error:(NSError *)error {
    if (error) {
        sendJSON(@{@"type": @"error", @"message": [NSString stringWithFormat:@"Characteristic discovery failed: %@", error.localizedDescription]});
        exit(1);
    }
    CBCharacteristic *chrc = nil;
    for (CBCharacteristic *c in service.characteristics) {
        if ([c.UUID isEqual:ZMK_RPC_CHRC_UUID]) { chrc = c; break; }
    }
    if (!chrc) {
        sendJSON(@{@"type": @"error", @"message": @"RPC characteristic not found on device"});
        exit(1);
    }
    self.rpcCharacteristic = chrc;
    [peripheral setNotifyValue:YES forCharacteristic:chrc];
    NSString *name = peripheral.name ?: peripheral.identifier.UUIDString;
    sendJSON(@{@"type": @"connected", @"name": name});
}

// MARK: - CBPeripheralDelegate — data

- (void)peripheral:(CBPeripheral *)peripheral
    didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic
                              error:(NSError *)error {
    if (error || !characteristic.value) return;
    NSData *data = characteristic.value;
    NSMutableArray *bytes = [NSMutableArray arrayWithCapacity:data.length];
    const uint8_t *buf = data.bytes;
    for (NSUInteger i = 0; i < data.length; i++) {
        [bytes addObject:@(buf[i])];
    }
    sendJSON(@{@"type": @"data", @"bytes": bytes});
}

// MARK: - Commands from host

- (void)connectToId:(NSString *)targetId {
    // Check bonded first (may not be in `discovered` if discovered[] was empty).
    NSArray<CBPeripheral *> *bonded = [self.central retrieveConnectedPeripheralsWithServices:@[ZMK_SERVICE_UUID]];
    for (CBPeripheral *p in bonded) {
        if ([p.identifier.UUIDString isEqualToString:targetId]) {
            [self setupAndConnect:p];
            return;
        }
    }

    // Check scan results.
    CBPeripheral *p = self.discovered[targetId];
    if (p) { [self setupAndConnect:p]; return; }

    // Last resort: retrieve by UUID from CoreBluetooth cache.
    NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:targetId];
    if (uuid) {
        NSArray<CBPeripheral *> *retrieved = [self.central retrievePeripheralsWithIdentifiers:@[uuid]];
        if (retrieved.count > 0) {
            [self setupAndConnect:retrieved[0]];
            return;
        }
    }

    sendJSON(@{@"type": @"error", @"message": [NSString stringWithFormat:@"Peripheral not found: %@", targetId]});
    exit(1);
}

- (void)setupAndConnect:(CBPeripheral *)peripheral {
    self.connectedPeripheral = peripheral;
    peripheral.delegate = self;
    if (peripheral.state == CBPeripheralStateConnected) {
        // Already GATT-connected — skip the connect step.
        [peripheral discoverServices:@[ZMK_SERVICE_UUID]];
    } else {
        [self.central connectPeripheral:peripheral options:nil];
    }
}

- (void)writeBytes:(NSArray<NSNumber *> *)numbers {
    if (!self.connectedPeripheral || !self.rpcCharacteristic) return;
    NSMutableData *data = [NSMutableData dataWithCapacity:numbers.count];
    for (NSNumber *n in numbers) {
        uint8_t byte = (uint8_t)n.intValue;
        [data appendBytes:&byte length:1];
    }
    [self.connectedPeripheral writeValue:data forCharacteristic:self.rpcCharacteristic type:CBCharacteristicWriteWithResponse];
}

- (void)disconnect {
    if (self.connectedPeripheral) {
        [self.central cancelPeripheralConnection:self.connectedPeripheral];
    } else {
        exit(0);
    }
}

@end

// ── Entry point ───────────────────────────────────────────────────────────────

int main(int argc, char *argv[]) {
    @autoreleasepool {
        ZMK_SERVICE_UUID  = [CBUUID UUIDWithString:@"00000000-0196-6107-c967-c5cfb1c2482a"];
        ZMK_RPC_CHRC_UUID = [CBUUID UUIDWithString:@"00000001-0196-6107-c967-c5cfb1c2482a"];

        BLEHelper *helper = [[BLEHelper alloc] init];

        // Read JSON commands from stdin on a background thread.
        dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
            NSFileHandle *stdin_fh = [NSFileHandle fileHandleWithStandardInput];
            NSMutableData *buffer = [NSMutableData data];

            while (YES) {
                NSData *chunk = [stdin_fh availableData];
                if (!chunk || chunk.length == 0) { exit(0); }
                [buffer appendData:chunk];

                // Process all complete lines.
                while (YES) {
                    NSRange nlRange = [buffer rangeOfData:[NSData dataWithBytes:"\n" length:1]
                                                   options:0
                                                     range:NSMakeRange(0, buffer.length)];
                    if (nlRange.location == NSNotFound) break;

                    NSData *lineData = [buffer subdataWithRange:NSMakeRange(0, nlRange.location)];
                    [buffer replaceBytesInRange:NSMakeRange(0, nlRange.location + 1) withBytes:NULL length:0];

                    if (lineData.length == 0) continue;

                    NSError *err = nil;
                    NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:&err];
                    if (!cmd || ![cmd isKindOfClass:[NSDictionary class]]) continue;

                    NSString *type = cmd[@"cmd"];
                    if (!type) continue;

                    dispatch_async(dispatch_get_main_queue(), ^{
                        if ([type isEqualToString:@"connect"]) {
                            NSString *targetId = cmd[@"id"];
                            if (targetId) [helper connectToId:targetId];
                        } else if ([type isEqualToString:@"write"]) {
                            NSArray *bytes = cmd[@"bytes"];
                            if (bytes) [helper writeBytes:bytes];
                        } else if ([type isEqualToString:@"disconnect"]) {
                            [helper disconnect];
                        }
                    });
                }
            }
        });

        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
