import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart' as permission_handler;
import 'dart:typed_data';
import 'dart:async';
import '../firebase_options.dart';
import 'login_screen.dart';

class AdminOptionsScreen extends StatefulWidget {
  final String userEmail;

  const AdminOptionsScreen({super.key, required this.userEmail});

  @override
  State<AdminOptionsScreen> createState() => _AdminOptionsScreenState();
}

class _AdminOptionsScreenState extends State<AdminOptionsScreen> {
  final ImagePicker _imagePicker = ImagePicker();
  static const int _maxManagedUsers = 4;
  static const int _maxLocations = 4;
  static const double _arrivalRadiusMeters = 50;
  static const double _exitRadiusMeters = 100;
  Timer? _proximityTimer;
  bool _isCheckingProximity = false;

  @override
  void initState() {
    super.initState();
    _ensureLocationPermissionAndStartChecks();
  }

  @override
  void dispose() {
    _proximityTimer?.cancel();
    super.dispose();
  }

  Future<void> _ensureLocationPermissionAndStartChecks() async {
    final hasPermission = await _ensureLocationPermission(showFeedback: false);
    if (!hasPermission) {
      return;
    }

    _proximityTimer?.cancel();
    _checkAndUpdateNearbyLocation();
    _proximityTimer = Timer.periodic(
      const Duration(seconds: 20),
      (_) => _checkAndUpdateNearbyLocation(),
    );
  }

  Future<bool> _openAppSettingsWithFallback() async {
    if (kIsWeb) {
      return false;
    }

    final openedByPermissionHandler =
        await permission_handler.openAppSettings();
    if (openedByPermissionHandler) {
      return true;
    }
    return Geolocator.openAppSettings();
  }

  Future<void> _showSettingsOpenFailedMessage() async {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(
          'Could not open settings automatically. Please open app settings manually.',
        ),
      ),
    );
  }

  Future<bool> _ensureLocationPermission({bool showFeedback = true}) async {
    final serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      if (showFeedback && mounted) {
        final shouldOpenLocationSettings = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Location services are off'),
            content: const Text(
              'Please enable device location services to use GPS features.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Not now'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Open Location Settings'),
              ),
            ],
          ),
        );

        if (shouldOpenLocationSettings == true) {
          final opened = await Geolocator.openLocationSettings();
          if (!opened) {
            await _showSettingsOpenFailedMessage();
          }
        }
      }
      return false;
    }

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }

    if (permission == LocationPermission.denied) {
      if (showFeedback && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Location permission is required.')),
        );
      }
      return false;
    }

    if (permission == LocationPermission.deniedForever) {
      if (showFeedback && mounted) {
        final shouldOpenSettings = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Location permission needed'),
            content: const Text(
              'Location permission is permanently denied. Open app settings to enable it?',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Not now'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Open Settings'),
              ),
            ],
          ),
        );

        if (shouldOpenSettings == true) {
          final opened = await _openAppSettingsWithFallback();
          if (!opened) {
            await _showSettingsOpenFailedMessage();
          }
        }
      }
      return false;
    }

    return true;
  }

  Future<bool> _ensureMicrophonePermission() async {
    if (kIsWeb) {
      return true;
    }

    var status = await permission_handler.Permission.microphone.status;
    if (!status.isGranted) {
      status = await permission_handler.Permission.microphone.request();
    }

    if (status.isGranted) {
      return true;
    }

    if (mounted) {
      final shouldOpenSettings = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Microphone permission needed'),
          content: const Text(
            'Recording requires microphone permission. Open app settings to enable it?',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Not now'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Open Settings'),
            ),
          ],
        ),
      );

      if (shouldOpenSettings == true) {
        final opened = await _openAppSettingsWithFallback();
        if (!opened) {
          await _showSettingsOpenFailedMessage();
        }
      }
    }

    return false;
  }

  Future<void> _checkAndUpdateNearbyLocation() async {
    if (_isCheckingProximity) {
      return;
    }

    final currentUser = FirebaseAuth.instance.currentUser;
    if (currentUser == null) {
      return;
    }

    _isCheckingProximity = true;
    try {
      final userRef = FirebaseFirestore.instance
          .collection('users')
          .doc(currentUser.uid);
      final userSnapshot = await userRef.get();
      final userData = userSnapshot.data();
      if (userData == null) {
        return;
      }

      final savedLocations = userData['location'];
      if (savedLocations is! Map<String, dynamic> || savedLocations.isEmpty) {
        return;
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.best,
        ),
      );

      final currentLocation = userData['currentLocation'] as String?;
      String? nearestLocation;
      double? nearestDistance;
      double? currentLocationDistance;

      for (final entry in savedLocations.entries) {
        final locationName = entry.key;
        final locationData = entry.value;
        if (locationData is! Map<String, dynamic>) {
          continue;
        }

        final latitude = (locationData['latitude'] as num?)?.toDouble();
        final longitude = (locationData['longitude'] as num?)?.toDouble();
        if (latitude == null || longitude == null) {
          continue;
        }

        final distance = Geolocator.distanceBetween(
          position.latitude,
          position.longitude,
          latitude,
          longitude,
        );

        if (currentLocation == locationName) {
          currentLocationDistance = distance;
        }

        if (distance <= _arrivalRadiusMeters &&
            (nearestDistance == null || distance < nearestDistance)) {
          nearestDistance = distance;
          nearestLocation = locationName;
        }
      }

      if (nearestLocation != null) {
        if (currentLocation == nearestLocation) {
          return;
        }

        await userRef.set({
          'currentLocation': nearestLocation,
          'lastUpdated': FieldValue.serverTimestamp(),
        }, SetOptions(merge: true));
        return;
      }

      if (currentLocation != null &&
          currentLocationDistance != null &&
          currentLocationDistance > _exitRadiusMeters) {
        await userRef.set({
          'currentLocation': null,
          'lastUpdated': FieldValue.serverTimestamp(),
        }, SetOptions(merge: true));
      }
    } catch (error) {
      debugPrint('Proximity check failed: $error');
    } finally {
      _isCheckingProximity = false;
    }
  }

  String? _readFirstStringField(
    Map<String, dynamic> data,
    List<String> fieldNames,
  ) {
    for (final field in fieldNames) {
      final value = data[field];
      if (value is String && value.trim().isNotEmpty) {
        return value.trim();
      }
    }
    return null;
  }

  Future<_PickedUploadFile?> _pickUploadFile(FileType fileType) async {
    final result =
        await FilePicker.platform.pickFiles(type: fileType, withData: true);
    if (result == null || result.files.isEmpty) {
      return null;
    }

    final selectedFile = result.files.single;
    final bytes = selectedFile.bytes;
    if (bytes == null) {
      throw Exception('The selected file could not be read.');
    }

    return _PickedUploadFile(name: selectedFile.name, bytes: bytes);
  }

  String _sanitizeStorageSegment(String value) {
    final sanitized =
        value.trim().toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '_');
    return sanitized.isEmpty ? 'location' : sanitized;
  }

  String _contentTypeForFileName(String fileName, String fallback) {
    final extension =
        fileName.contains('.') ? fileName.split('.').last.toLowerCase() : '';
    switch (extension) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'mp3':
        return 'audio/mpeg';
      case 'wav':
        return 'audio/wav';
      case 'm4a':
        return 'audio/mp4';
      case 'aac':
        return 'audio/aac';
      case 'ogg':
        return 'audio/ogg';
      default:
        return fallback;
    }
  }

  bool _isEspUserRecord(Map<String, dynamic> data, String docId) {
    final candidates = <String>[
      docId,
      _readFirstStringField(data, const ['role']) ?? '',
      _readFirstStringField(data, const ['type']) ?? '',
      _readFirstStringField(data, const ['deviceType']) ?? '',
      _readFirstStringField(data, const ['name', 'displayName', 'fullName']) ?? '',
      _readFirstStringField(data, const ['email', 'mail']) ?? '',
    ].map((value) => value.toLowerCase()).toList();

    return candidates.any(
      (value) =>
          value.contains('esp') ||
          value.contains('hardware') ||
          value.contains('device'),
    );
  }

  Future<List<_ManagedUser>> _fetchManagedUsers({bool excludeEsp = false}) async {
    final snapshot =
        await FirebaseFirestore.instance.collection('users').get();
    final currentUid = FirebaseAuth.instance.currentUser?.uid;
    final currentEmail = FirebaseAuth.instance.currentUser?.email?.trim();

    final users = <_ManagedUser>[];
    for (final doc in snapshot.docs) {
      final data = doc.data();
      final isEspUser = _isEspUserRecord(data, doc.id);
      if (excludeEsp && isEspUser) {
        continue;
      }

      final resolvedUid = _readFirstStringField(data, const [
            'uid',
            'userUid',
            'authUid',
          ]) ??
          doc.id;
      final name = _readFirstStringField(data, const [
        'name',
        'displayName',
        'fullName',
        'username',
        'userName',
      ]);
      final email = _readFirstStringField(data, const ['email', 'mail']) ??
          (resolvedUid == currentUid ? currentEmail : null);
      final displayName = (name != null && name.isNotEmpty)
          ? name
          : (email != null && email.isNotEmpty)
              ? email
              : 'Unknown user';

      users.add(
        _ManagedUser(
          docId: doc.id,
          uid: resolvedUid,
          displayName: displayName,
          email: email,
          isEspUser: isEspUser,
        ),
      );
    }

    users.sort(
      (a, b) => a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()),
    );
    return users;
  }

  Future<List<_ManagedLocation>> _fetchManagedLocations() async {
    final snapshot = await FirebaseFirestore.instance
        .collection('locations')
        .orderBy('locationName')
        .get();

    final locations = <_ManagedLocation>[];
    for (final doc in snapshot.docs) {
      final data = doc.data();
      final name = data['locationName'];
      if (name is! String || name.trim().isEmpty) {
        continue;
      }

      locations.add(
        _ManagedLocation(
          docId: doc.id,
          name: name.trim(),
          imageUrl: data['imageUrl'] as String?,
          soundUrl: data['soundUrl'] as String?,
        ),
      );
    }

    return locations;
  }

  Future<_PickedUploadFile?> _pickImageFromSource(ImageSource source) async {
    final picked =
        await _imagePicker.pickImage(source: source, imageQuality: 90);
    if (picked == null) {
      return null;
    }

    final bytes = await picked.readAsBytes();
    return _PickedUploadFile(name: picked.name, bytes: bytes);
  }

  Future<_PickedUploadFile?> _recordVoiceMessage() async {
    final recorder = AudioRecorder();
    final timestamp = DateTime.now().millisecondsSinceEpoch;

    try {
      final micGranted = await _ensureMicrophonePermission();
      if (!micGranted || !await recorder.hasPermission()) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Microphone permission is required.')),
          );
        }
        return null;
      }

      final config = RecordConfig(
        encoder: kIsWeb ? AudioEncoder.opus : AudioEncoder.aacLc,
        bitRate: 128000,
        sampleRate: 44100,
      );

      if (kIsWeb) {
        await recorder.start(
          config,
          path: 'voice_message_$timestamp.webm',
        );
      } else {
        final tempDirectory = await getTemporaryDirectory();
        final path = '${tempDirectory.path}/voice_message_$timestamp.m4a';
        await recorder.start(config, path: path);
      }

      if (!mounted) {
        await recorder.cancel();
        return null;
      }

      final shouldSave = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (context) => AlertDialog(
          title: const Text('Recording in progress'),
          content: const Text('Tap "Stop & Use" when you are done recording.'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Stop & Use'),
            ),
          ],
        ),
      );

      if (shouldSave != true) {
        await recorder.cancel();
        return null;
      }

      final recordedPath = await recorder.stop();
      if (recordedPath == null) {
        throw Exception('Recording failed to save.');
      }

      final bytes = await XFile(recordedPath).readAsBytes();
      return _PickedUploadFile(
        name: 'voice_message_$timestamp.${kIsWeb ? 'webm' : 'm4a'}',
        bytes: bytes,
      );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Recording failed: $error')),
        );
      }
      return null;
    } finally {
      await recorder.dispose();
    }
  }

  Future<_GreetingMediaSelection?> _pickGreetingMedia() async {
    final source = await showModalBottomSheet<_GreetingMediaSource>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.camera_alt_outlined),
              title: const Text('Open Camera'),
              onTap: () => Navigator.pop(context, _GreetingMediaSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Choose From Gallery'),
              onTap: () => Navigator.pop(context, _GreetingMediaSource.gallery),
            ),
            ListTile(
              leading: const Icon(Icons.mic_outlined),
              title: const Text('Open Recorder'),
              onTap: () =>
                  Navigator.pop(context, _GreetingMediaSource.recorder),
            ),
            ListTile(
              leading: const Icon(Icons.audio_file_outlined),
              title: const Text('Choose Audio File'),
              onTap: () =>
                  Navigator.pop(context, _GreetingMediaSource.audioFile),
            ),
          ],
        ),
      ),
    );

    if (source == null) {
      return null;
    }

    switch (source) {
      case _GreetingMediaSource.camera:
        final image = await _pickImageFromSource(ImageSource.camera);
        if (image == null) {
          return null;
        }
        return _GreetingMediaSelection(
          file: image,
          type: _GreetingMediaType.visual,
        );
      case _GreetingMediaSource.gallery:
        final image = await _pickImageFromSource(ImageSource.gallery);
        if (image == null) {
          return null;
        }
        return _GreetingMediaSelection(
          file: image,
          type: _GreetingMediaType.visual,
        );
      case _GreetingMediaSource.recorder:
        final recording = await _recordVoiceMessage();
        if (recording == null) {
          return null;
        }
        return _GreetingMediaSelection(
          file: recording,
          type: _GreetingMediaType.voice,
        );
      case _GreetingMediaSource.audioFile:
        final audio = await _pickUploadFile(FileType.audio);
        if (audio == null) {
          return null;
        }
        return _GreetingMediaSelection(
          file: audio,
          type: _GreetingMediaType.voice,
        );
    }
  }

  Future<_UploadedLocationAsset> _uploadGreetingMedia({
    required String collection,
    required _PickedUploadFile file,
    required String fallbackContentType,
  }) async {
    final safeFileName = _sanitizeStorageSegment(file.name);
    final path =
        'greetings/$collection/${DateTime.now().millisecondsSinceEpoch}_$safeFileName';
    final ref = FirebaseStorage.instance.ref(path);

    await ref.putData(
      file.bytes,
      SettableMetadata(
        contentType: _contentTypeForFileName(file.name, fallbackContentType),
      ),
    );

    final downloadUrl = await ref.getDownloadURL();
    return _UploadedLocationAsset(ref: ref, downloadUrl: downloadUrl);
  }

  Future<_UploadedLocationAsset> _uploadUserVoiceRecording({
    required String userId,
    required _PickedUploadFile file,
  }) async {
    final safeFileName = _sanitizeStorageSegment(file.name);
    final path =
        'user_voice/$userId/${DateTime.now().millisecondsSinceEpoch}_$safeFileName';
    final ref = FirebaseStorage.instance.ref(path);

    await ref.putData(
      file.bytes,
      SettableMetadata(
        contentType: _contentTypeForFileName(file.name, 'audio/mpeg'),
      ),
    );

    final downloadUrl = await ref.getDownloadURL();
    return _UploadedLocationAsset(ref: ref, downloadUrl: downloadUrl);
  }

  Future<_UploadedLocationAsset> _uploadLocationAsset({
    required String locationId,
    required String folder,
    required _PickedUploadFile file,
    required String fallbackContentType,
  }) async {
    final safeFileName = _sanitizeStorageSegment(file.name);
    final path =
        'locations/$locationId/$folder/${DateTime.now().millisecondsSinceEpoch}_$safeFileName';
    final ref = FirebaseStorage.instance.ref(path);

    await ref.putData(
      file.bytes,
      SettableMetadata(
        contentType: _contentTypeForFileName(file.name, fallbackContentType),
      ),
    );

    final downloadUrl = await ref.getDownloadURL();
    return _UploadedLocationAsset(ref: ref, downloadUrl: downloadUrl);
  }

  Future<List<String>> _fetchLocationNames() async {
    final names = <String>{};
    for (final location in await _fetchManagedLocations()) {
      names.add(location.name);
    }

    return names.toList()..sort();
  }

  Future<String?> _showLocationPicker(List<String> locations) {
    String selected = locations.first;

    return showDialog<String>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Update Location'),
          content: DropdownButtonFormField<String>(
            initialValue: selected,
            items: locations
                .map(
                  (location) => DropdownMenuItem<String>(
                    value: location,
                    child: Text(location),
                  ),
                )
                .toList(),
            onChanged: (value) {
              if (value != null) {
                setDialogState(() {
                  selected = value;
                });
              }
            },
            decoration: const InputDecoration(
              labelText: 'Choose location',
              border: OutlineInputBorder(),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, selected),
              child: const Text('Update'),
            ),
          ],
        ),
      ),
    );
  }

  Future<_ManagedLocation?> _showManagedLocationPicker(
    List<_ManagedLocation> locations, {
    required String title,
    required String confirmLabel,
  }) {
    String selectedId = locations.first.docId;

    return showDialog<_ManagedLocation>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(title),
          content: DropdownButtonFormField<String>(
            initialValue: selectedId,
            items: locations
                .map(
                  (location) => DropdownMenuItem<String>(
                    value: location.docId,
                    child: Text(location.name),
                  ),
                )
                .toList(),
            onChanged: (value) {
              if (value != null) {
                setDialogState(() {
                  selectedId = value;
                });
              }
            },
            decoration: const InputDecoration(
              labelText: 'Choose location',
              border: OutlineInputBorder(),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(
                context,
                locations.firstWhere((location) => location.docId == selectedId),
              ),
              child: Text(confirmLabel),
            ),
          ],
        ),
      ),
    );
  }

  Future<_ManagedUser?> _showManagedUserPicker(
    List<_ManagedUser> users, {
    required String title,
    required String confirmLabel,
  }) {
    String selectedId = users.first.docId;

    return showDialog<_ManagedUser>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(title),
          content: DropdownButtonFormField<String>(
            initialValue: selectedId,
            items: users
                .map(
                  (user) => DropdownMenuItem<String>(
                    value: user.docId,
                    child: Text(user.displayName),
                  ),
                )
                .toList(),
            onChanged: (value) {
              if (value != null) {
                setDialogState(() {
                  selectedId = value;
                });
              }
            },
            decoration: const InputDecoration(
              labelText: 'Choose user',
              border: OutlineInputBorder(),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(
                context,
                users.firstWhere((user) => user.docId == selectedId),
              ),
              child: Text(confirmLabel),
            ),
          ],
        ),
      ),
    );
  }

  Future<_GpsCoordinate?> _showGpsPointPicker({
    required LatLng initialPoint,
  }) async {
    LatLng? selectedPoint;

    final result = await showDialog<_GpsCoordinate>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Set GPS Point'),
          content: SizedBox(
            width: 420,
            height: 360,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: FlutterMap(
                      options: MapOptions(
                        initialCenter: initialPoint,
                        initialZoom: 12,
                        onTap: (_, point) {
                          setDialogState(() {
                            selectedPoint = point;
                          });
                        },
                      ),
                      children: [
                        TileLayer(
                          urlTemplate:
                              'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                          userAgentPackageName: 'com.iot.technion.wesleys_clock',
                        ),
                        if (selectedPoint != null)
                          MarkerLayer(
                            markers: [
                              Marker(
                                point: selectedPoint!,
                                width: 44,
                                height: 44,
                                child: const Icon(
                                  Icons.location_pin,
                                  color: Colors.red,
                                  size: 40,
                                ),
                              ),
                            ],
                          ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  selectedPoint == null
                      ? 'Tap on the map to choose a point.'
                      : 'Lat: ${selectedPoint!.latitude.toStringAsFixed(6)}, '
                          'Lng: ${selectedPoint!.longitude.toStringAsFixed(6)}',
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: selectedPoint == null
                  ? null
                  : () => Navigator.pop(
                        context,
                        _GpsCoordinate(
                          latitude: selectedPoint!.latitude,
                          longitude: selectedPoint!.longitude,
                        ),
                      ),
              child: const Text('Save Point'),
            ),
          ],
        ),
      ),
    );

    return result;
  }

  Future<List<_PromptRecipient>> _fetchPromptRecipients() async {
    final snapshot =
        await FirebaseFirestore.instance.collection('users').get();
    final currentUid = FirebaseAuth.instance.currentUser?.uid;
    final currentEmail = FirebaseAuth.instance.currentUser?.email?.trim();

    final seenUids = <String>{};
    final recipients = <_PromptRecipient>[];
    for (final doc in snapshot.docs) {
      final data = doc.data();
      final resolvedUid = _readFirstStringField(data, const [
            'uid',
            'userUid',
            'authUid',
          ]) ??
          doc.id;
      final name = _readFirstStringField(data, const [
        'name',
        'displayName',
        'fullName',
        'username',
        'userName',
      ]);
      final email = _readFirstStringField(data, const ['email', 'mail']) ??
          (resolvedUid == currentUid ? currentEmail : null);
      final displayName =
          (name != null && name.isNotEmpty)
              ? name
              : (email != null && email.isNotEmpty)
              ? email
              : 'Unknown user';

      if (seenUids.contains(resolvedUid)) {
        continue;
      }
      seenUids.add(resolvedUid);

      recipients.add(
        _PromptRecipient(
          uid: resolvedUid,
          displayName: displayName,
          email: email,
        ),
      );
    }

    recipients.sort(
      (a, b) => a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()),
    );
    return recipients;
  }

  String _formatPromptSchedule(BuildContext ctx, DateTime scheduledFor) {
    final now = DateTime.now();
    final isToday =
        scheduledFor.year == now.year &&
        scheduledFor.month == now.month &&
        scheduledFor.day == now.day;
    final dayLabel = isToday ? 'Today' : 'Tomorrow';
    final formattedTime = TimeOfDay.fromDateTime(scheduledFor).format(ctx);
    return '$dayLabel at $formattedTime';
  }

  Future<_PromptComposeResult?> _showPromptComposer(
    List<_PromptRecipient> recipients,
  ) {
    return showDialog<_PromptComposeResult>(
      context: context,
      builder: (_) => _PromptComposerDialog(
        recipients: recipients,
        formatSchedule: _formatPromptSchedule,
      ),
    );
  }

  Future<void> _promptSomeone() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('You must be logged in to send prompts.')),
      );
      return;
    }

    try {
      final recipients = await _fetchPromptRecipients();
      if (!mounted) {
        return;
      }

      if (recipients.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No users found in Firebase.')),
        );
        return;
      }

      final composed = await _showPromptComposer(recipients);
      if (!mounted || composed == null) {
        return;
      }

      final docRef = FirebaseFirestore.instance.collection('prompts').doc();
      await docRef.set({
        'id': docRef.id,
        'targetUserId': composed.recipient.uid,
        'targetUserName': composed.recipient.displayName,
        'targetUserEmail': composed.recipient.email,
        'createdByUserId': user.uid,
        'createdByEmail': widget.userEmail,
        'promptText': composed.promptText,
        'scheduledFor': Timestamp.fromDate(composed.scheduledFor),
        'isRead': false,
        'status': 'scheduled',
        'createdAt': FieldValue.serverTimestamp(),
      });

      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Prompt scheduled for ${composed.recipient.displayName} (${_formatPromptSchedule(context, composed.scheduledFor)}).',
          ),
        ),
      );
    } catch (_) {
      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Failed to send prompt. Please try again.'),
        ),
      );
    }
  }

  Stream<QuerySnapshot<Map<String, dynamic>>> _promptStreamForCurrentUser() {
    final currentUser = FirebaseAuth.instance.currentUser;
    if (currentUser == null) {
      return const Stream.empty();
    }

    return FirebaseFirestore.instance
        .collection('prompts')
        .where('targetUserId', isEqualTo: currentUser.uid)
        .snapshots();
  }

  Future<void> _markPromptAsRead(String promptId) async {
    await FirebaseFirestore.instance.collection('prompts').doc(promptId).set({
      'isRead': true,
      'status': 'read',
      'readAt': FieldValue.serverTimestamp(),
    }, SetOptions(merge: true));
  }

  Widget _buildPromptInbox() {
    final currentUser = FirebaseAuth.instance.currentUser;
    if (currentUser == null) {
      return const SizedBox.shrink();
    }

    return Card(
      margin: const EdgeInsets.only(top: 20),
      child: SizedBox(
        height: 280,
        child: Padding(
          padding: const EdgeInsets.all(12.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Prompt Inbox',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Expanded(
                child: StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
                  stream: _promptStreamForCurrentUser(),
                  builder: (context, snapshot) {
                    if (snapshot.hasError) {
                      return const Center(
                        child: Text('Failed to load prompts.'),
                      );
                    }

                    if (!snapshot.hasData) {
                      return const Center(child: CircularProgressIndicator());
                    }

                    final docs = [...snapshot.data!.docs];
                    docs.sort((a, b) {
                      final aTs = a.data()['scheduledFor'] as Timestamp?;
                      final bTs = b.data()['scheduledFor'] as Timestamp?;
                      if (aTs == null && bTs == null) {
                        return 0;
                      }
                      if (aTs == null) {
                        return 1;
                      }
                      if (bTs == null) {
                        return -1;
                      }
                      return bTs.compareTo(aTs);
                    });

                    if (docs.isEmpty) {
                      return const Center(
                        child: Text('No prompts yet.'),
                      );
                    }

                    final now = DateTime.now();

                    return ListView.separated(
                      itemCount: docs.length,
                      separatorBuilder: (_, __) => const Divider(height: 1),
                      itemBuilder: (context, index) {
                        final doc = docs[index];
                        final data = doc.data();
                        final text = (data['promptText'] as String?)?.trim();
                        final senderName =
                            (data['createdByEmail'] as String?) ?? 'Unknown';
                        final isRead = data['isRead'] == true;
                        final scheduledForTs = data['scheduledFor'] as Timestamp?;
                        final scheduledFor = scheduledForTs?.toDate();
                        final isDue =
                            scheduledFor == null || !scheduledFor.isAfter(now);
                        final timeLabel = scheduledFor == null
                            ? 'Now'
                            : TimeOfDay.fromDateTime(scheduledFor)
                                .format(context);

                        return ListTile(
                          contentPadding: EdgeInsets.zero,
                          title: Text(
                            text == null || text.isEmpty ? '(No text)' : text,
                          ),
                          subtitle: Text(
                            isDue
                                ? 'From $senderName · $timeLabel'
                                : 'Scheduled for $timeLabel · From $senderName',
                          ),
                          trailing: !isRead && isDue
                              ? TextButton(
                                  onPressed: () => _markPromptAsRead(doc.id),
                                  child: const Text('Mark Read'),
                                )
                              : Icon(
                                  isRead
                                      ? Icons.check_circle
                                      : Icons.schedule,
                                  color: isRead
                                      ? Colors.green
                                      : Theme.of(context)
                                          .colorScheme
                                          .secondary,
                                ),
                        );
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _updateLocation() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('You must be logged in to update location.')),
      );
      return;
    }

    try {
      final locations = await _fetchLocationNames();
      if (!mounted) {
        return;
      }

      if (locations.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No locations found in Firebase.')),
        );
        return;
      }

      final selectedLocation = await _showLocationPicker(locations);
      if (!mounted || selectedLocation == null) {
        return;
      }

      await FirebaseFirestore.instance.collection('users').doc(user.uid).set({
        'currentLocation': selectedLocation,
        'lastUpdated': FieldValue.serverTimestamp(),
      }, SetOptions(merge: true));

      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Location updated to "$selectedLocation".')),
      );
    } catch (_) {
      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('Failed to update location. Please try again.')),
      );
    }
  }

  Future<void> _sendGreeting() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('You must be logged in to send a greeting.')),
      );
      return;
    }

    Reference? uploadedRef;

    try {
      final picked = await _pickGreetingMedia();
      if (picked == null) {
        return;
      }

      final collection = picked.type == _GreetingMediaType.voice
          ? 'voice_messages'
          : 'visual_messages';
      final fallbackContentType =
          picked.type == _GreetingMediaType.voice ? 'audio/mpeg' : 'image/jpeg';

      final uploaded = await _uploadGreetingMedia(
        collection: collection,
        file: picked.file,
        fallbackContentType: fallbackContentType,
      );
      uploadedRef = uploaded.ref;

      final docRef = FirebaseFirestore.instance.collection(collection).doc();
      await docRef.set({
        'id': docRef.id,
        'status': 'ready to play',
        'targetUserId': user.uid,
        'targetUserEmail': user.email ?? widget.userEmail,
        'uploadedByUserId': user.uid,
        'uploadedByEmail': widget.userEmail,
        'fileName': picked.file.name,
        'mediaUrl': uploaded.downloadUrl,
        'storagePath': uploaded.ref.fullPath,
        'contentType': _contentTypeForFileName(
          picked.file.name,
          fallbackContentType,
        ),
        'createdAt': FieldValue.serverTimestamp(),
      });

      if (!mounted) {
        return;
      }

      final kind = picked.type == _GreetingMediaType.voice ? 'voice' : 'visual';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Your $kind greeting is ready to play.')),
      );
    } catch (_) {
      if (uploadedRef != null) {
        try {
          await uploadedRef.delete();
        } catch (_) {}
      }

      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Failed to send greeting. Please try again.'),
        ),
      );
    }
  }

  Future<void> _saveUserVoice() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('You must be logged in to save your voice.'),
        ),
      );
      return;
    }

    try {
      final recording = await _recordVoiceMessage();
      if (recording == null) {
        return;
      }

      final uploaded = await _uploadUserVoiceRecording(
        userId: user.uid,
        file: recording,
      );

      await FirebaseFirestore.instance.collection('users').doc(user.uid).set({
        'user_voice': uploaded.downloadUrl,
        'userVoiceUpdatedAt': FieldValue.serverTimestamp(),
      }, SetOptions(merge: true));

      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Your voice recording was saved.')),
      );
    } catch (_) {
      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Failed to save your voice. Please try again.'),
        ),
      );
    }
  }

  Future<void> _setGpsLocation() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('You must be logged in to set GPS.')),
      );
      return;
    }

    try {
      final hasLocationPermission = await _ensureLocationPermission();
      if (!hasLocationPermission) {
        return;
      }

      final locations = await _fetchLocationNames();
      if (!mounted) {
        return;
      }

      if (locations.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No locations found in Firebase.')),
        );
        return;
      }

      final selectedLocation = await _showLocationPicker(locations);
      if (!mounted || selectedLocation == null) {
        return;
      }

      LatLng initialPoint = const LatLng(31.7683, 35.2137);
      try {
        final position = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.best,
          ),
        );
        initialPoint = LatLng(position.latitude, position.longitude);
      } catch (_) {}

      final selectedPoint = await _showGpsPointPicker(initialPoint: initialPoint);
      if (!mounted || selectedPoint == null) {
        return;
      }

      final userRef =
          FirebaseFirestore.instance.collection('users').doc(user.uid);
      final userSnapshot = await userRef.get();

      final existingLocationData =
          userSnapshot.data()?['location'] as Map<String, dynamic>?;
      final updatedLocationData = existingLocationData == null
          ? <String, dynamic>{}
          : Map<String, dynamic>.from(existingLocationData);

      updatedLocationData[selectedLocation] = {
        'latitude': selectedPoint.latitude,
        'longitude': selectedPoint.longitude,
      };

      await userRef.set({
        'location': updatedLocationData,
        'lastUpdated': FieldValue.serverTimestamp(),
      }, SetOptions(merge: true));

      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'GPS saved for "$selectedLocation" '
            '(${selectedPoint.latitude.toStringAsFixed(6)}, '
            '${selectedPoint.longitude.toStringAsFixed(6)}).',
          ),
        ),
      );
    } catch (_) {
      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Failed to set GPS location. Please try again.'),
        ),
      );
    }
  }

  Future<void> _removeLocation() async {
    try {
      final locations = await _fetchManagedLocations();
      if (!mounted) {
        return;
      }

      if (locations.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No locations available to remove.')),
        );
        return;
      }

      final selectedLocation = await _showManagedLocationPicker(
        locations,
        title: 'Remove Location',
        confirmLabel: 'Remove',
      );
      if (!mounted || selectedLocation == null) {
        return;
      }

      final firestore = FirebaseFirestore.instance;
      final usersSnapshot = await firestore.collection('users').get();
      for (final userDoc in usersSnapshot.docs) {
        final data = userDoc.data();
        final existingLocationData = data['location'];
        final updates = <String, dynamic>{};

        if (existingLocationData is Map<String, dynamic> &&
            existingLocationData.containsKey(selectedLocation.name)) {
          final updatedLocationData =
              Map<String, dynamic>.from(existingLocationData)
                ..remove(selectedLocation.name);
          updates['location'] = updatedLocationData.isEmpty
              ? FieldValue.delete()
              : updatedLocationData;
        }

        if (data['currentLocation'] == selectedLocation.name) {
          updates['currentLocation'] = FieldValue.delete();
        }

        if (updates.isNotEmpty) {
          await userDoc.reference.update(updates);
        }
      }

      final storage = FirebaseStorage.instance;
      for (final assetUrl in [selectedLocation.imageUrl, selectedLocation.soundUrl]) {
        if (assetUrl == null || assetUrl.isEmpty) {
          continue;
        }
        try {
          await storage.refFromURL(assetUrl).delete();
        } catch (_) {}
      }

      await firestore.collection('locations').doc(selectedLocation.docId).delete();

      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Location "${selectedLocation.name}" removed.'),
        ),
      );
    } catch (_) {
      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Failed to remove location. Please try again.'),
        ),
      );
    }
  }

  Future<void> _removeUser() async {
    try {
      final currentUid = FirebaseAuth.instance.currentUser?.uid;
      final users = (await _fetchManagedUsers(excludeEsp: true))
          .where((user) => user.uid != currentUid)
          .toList();
      if (!mounted) {
        return;
      }

      if (users.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('No other users are available to remove.'),
          ),
        );
        return;
      }

      final selectedUser = await _showManagedUserPicker(
        users,
        title: 'Remove User',
        confirmLabel: 'Remove',
      );
      if (!mounted || selectedUser == null) {
        return;
      }

      await FirebaseFirestore.instance
          .collection('users')
          .doc(selectedUser.docId)
          .delete();

      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('User "${selectedUser.displayName}" removed.'),
        ),
      );
    } catch (_) {
      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Failed to remove user. Please try again.'),
        ),
      );
    }
  }

  void _addUser() {
    _fetchManagedUsers(excludeEsp: true).then((users) {
      if (!mounted) {
        return;
      }

      if (users.length >= _maxManagedUsers) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Only 4 users are allowed, excluding the ESP user.'),
          ),
        );
        return;
      }

    final formKey = GlobalKey<FormState>();
    final nameController = TextEditingController();
    final emailController = TextEditingController();
    final passwordController = TextEditingController();
    bool isAdmin = false;
    bool isSubmitting = false;
    bool dialogClosing = false;

    showDialog<void>(
      context: context,
      barrierDismissible: !isSubmitting,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('Add User'),
          content: SingleChildScrollView(
            child: Form(
              key: formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextFormField(
                    controller: nameController,
                    textInputAction: TextInputAction.next,
                    decoration: const InputDecoration(
                      labelText: 'Name',
                      border: OutlineInputBorder(),
                    ),
                    validator: (value) {
                      if (value == null || value.trim().isEmpty) {
                        return 'Name is required';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: emailController,
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.next,
                    decoration: const InputDecoration(
                      labelText: 'Email',
                      border: OutlineInputBorder(),
                    ),
                    validator: (value) {
                      final email = value?.trim() ?? '';
                      if (email.isEmpty) {
                        return 'Email is required';
                      }
                      if (!email.contains('@') || !email.contains('.')) {
                        return 'Enter a valid email';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: passwordController,
                    obscureText: true,
                    textInputAction: TextInputAction.done,
                    decoration: const InputDecoration(
                      labelText: 'Password',
                      border: OutlineInputBorder(),
                    ),
                    validator: (value) {
                      if (value == null || value.isEmpty) {
                        return 'Password is required';
                      }
                      if (value.length < 6) {
                        return 'Password must be at least 6 characters';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 8),
                  SwitchListTile.adaptive(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Is Admin'),
                    value: isAdmin,
                    onChanged: isSubmitting
                        ? null
                        : (value) {
                            setDialogState(() {
                              isAdmin = value;
                            });
                          },
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: isSubmitting
                  ? null
                  : () {
                      dialogClosing = true;
                      Navigator.pop(dialogContext);
                    },
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: isSubmitting
                  ? null
                  : () async {
                      if (!formKey.currentState!.validate()) {
                        return;
                      }

                      setDialogState(() {
                        isSubmitting = true;
                      });

                      final name = nameController.text.trim();
                      final email = emailController.text.trim();
                      final password = passwordController.text;

                      FirebaseApp? tempApp;
                      try {
                        final users =
                            await _fetchManagedUsers(excludeEsp: true);
                        if (users.length >= _maxManagedUsers) {
                          if (dialogContext.mounted) {
                            setDialogState(() {
                              isSubmitting = false;
                            });
                          }
                          if (!mounted) {
                            return;
                          }
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content: Text(
                                'Only 4 users are allowed, excluding the ESP user.',
                              ),
                            ),
                          );
                          return;
                        }

                        tempApp = await Firebase.initializeApp(
                          name:
                              'admin-create-${DateTime.now().microsecondsSinceEpoch}',
                          options: DefaultFirebaseOptions.currentPlatform,
                        );

                        final tempAuth = FirebaseAuth.instanceFor(app: tempApp);
                        final credential =
                            await tempAuth.createUserWithEmailAndPassword(
                          email: email,
                          password: password,
                        );

                        final uid = credential.user!.uid;
                        await FirebaseFirestore.instance
                            .collection('users')
                            .doc(uid)
                            .set({
                          'name': name,
                          'email': email,
                          'isAdmin': isAdmin,
                          'role': isAdmin ? 'admin' : 'user',
                          'createdAt': FieldValue.serverTimestamp(),
                        });

                        await tempAuth.signOut();
                        await tempApp.delete();
                        tempApp = null;

                        if (!mounted || !dialogContext.mounted) {
                          return;
                        }

                        dialogClosing = true;
                        Navigator.pop(dialogContext);
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                              content:
                                  Text('User "$email" created successfully.')),
                        );
                      } on FirebaseAuthException catch (e) {
                        String message =
                            'Failed to create user. Please try again.';
                        if (e.code == 'email-already-in-use') {
                          message = 'That email is already in use.';
                        } else if (e.code == 'invalid-email') {
                          message = 'Please enter a valid email address.';
                        } else if (e.code == 'weak-password') {
                          message =
                              'Password is too weak (minimum 6 characters).';
                        }

                        if (mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text(message)),
                          );
                        }
                      } catch (_) {
                        if (mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content:
                                  Text('Unexpected error while creating user.'),
                            ),
                          );
                        }
                      } finally {
                        if (tempApp != null) {
                          await tempApp.delete();
                        }

                        if (dialogContext.mounted && !dialogClosing) {
                          setDialogState(() {
                            isSubmitting = false;
                          });
                        }
                      }
                    },
              child: isSubmitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Create'),
            ),
          ],
        ),
      ),
    ).whenComplete(() {
      nameController.dispose();
      emailController.dispose();
      passwordController.dispose();
    });
    });
  }

  void _addLocation() {
    _fetchManagedLocations().then((locations) {
      if (!mounted) {
        return;
      }

      if (locations.length >= _maxLocations) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Only 4 locations are allowed.')),
        );
        return;
      }

    final formKey = GlobalKey<FormState>();
    final locationController = TextEditingController();
    _PickedUploadFile? imageFile;
    _PickedUploadFile? audioFile;
    bool isSubmitting = false;
    bool dialogClosing = false;

    showDialog<void>(
      context: context,
      barrierDismissible: !isSubmitting,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('Add Location'),
          content: SingleChildScrollView(
            child: Form(
              key: formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextFormField(
                    controller: locationController,
                    textInputAction: TextInputAction.done,
                    decoration: const InputDecoration(
                      labelText: 'Location name',
                      border: OutlineInputBorder(),
                    ),
                    validator: (value) {
                      if (value == null || value.trim().isEmpty) {
                        return 'Location name is required';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 16),
                  OutlinedButton.icon(
                    onPressed: isSubmitting
                        ? null
                        : () async {
                            try {
                              final picked =
                                  await _pickUploadFile(FileType.image);
                              if (picked == null || !dialogContext.mounted) {
                                return;
                              }
                              setDialogState(() {
                                imageFile = picked;
                              });
                            } catch (_) {
                              if (!mounted) {
                                return;
                              }
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                    content: Text('Failed to pick an image.')),
                              );
                            }
                          },
                    icon: const Icon(Icons.image_outlined),
                    label: Text(imageFile == null
                        ? 'Choose Picture (optional)'
                        : 'Picture: ${imageFile!.name}'),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: isSubmitting
                        ? null
                        : () async {
                            try {
                              final picked =
                                  await _pickUploadFile(FileType.audio);
                              if (picked == null || !dialogContext.mounted) {
                                return;
                              }
                              setDialogState(() {
                                audioFile = picked;
                              });
                            } catch (_) {
                              if (!mounted) {
                                return;
                              }
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                    content:
                                        Text('Failed to pick an audio file.')),
                              );
                            }
                          },
                    icon: const Icon(Icons.audiotrack_outlined),
                    label: Text(audioFile == null
                        ? 'Choose Sound (optional)'
                        : 'Sound: ${audioFile!.name}'),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Any selected picture or sound will be uploaded to Firebase Storage and linked to this location. The clock angle will be assigned automatically by the backend.',
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: isSubmitting
                  ? null
                  : () {
                      dialogClosing = true;
                      Navigator.pop(dialogContext);
                    },
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: isSubmitting
                  ? null
                  : () async {
                      if (!formKey.currentState!.validate()) {
                        return;
                      }

                      setDialogState(() {
                        isSubmitting = true;
                      });

                      final locationName = locationController.text.trim();
                      final managedLocations = await _fetchManagedLocations();
                      if (managedLocations.length >= _maxLocations) {
                        if (dialogContext.mounted) {
                          setDialogState(() {
                            isSubmitting = false;
                          });
                        }
                        if (!mounted) {
                          return;
                        }
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Only 4 locations are allowed.'),
                          ),
                        );
                        return;
                      }

                      final existingLocation = await FirebaseFirestore.instance
                          .collection('locations')
                          .where('locationName', isEqualTo: locationName)
                          .limit(1)
                          .get();

                      if (existingLocation.docs.isNotEmpty) {
                        if (dialogContext.mounted) {
                          setDialogState(() {
                            isSubmitting = false;
                          });
                        }
                        if (!mounted) {
                          return;
                        }
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                              content: Text(
                                  'Location "$locationName" already exists.')),
                        );
                        return;
                      }

                      final docRef = FirebaseFirestore.instance
                          .collection('locations')
                          .doc();
                      final uploadedRefs = <Reference>[];

                      try {
                        String? imageUrl;
                        String? audioUrl;

                        if (imageFile != null) {
                          final uploadedImage = await _uploadLocationAsset(
                            locationId: docRef.id,
                            folder: 'images',
                            file: imageFile!,
                            fallbackContentType: 'image/jpeg',
                          );
                          uploadedRefs.add(uploadedImage.ref);
                          imageUrl = uploadedImage.downloadUrl;
                        }

                        if (audioFile != null) {
                          final uploadedAudio = await _uploadLocationAsset(
                            locationId: docRef.id,
                            folder: 'audio',
                            file: audioFile!,
                            fallbackContentType: 'audio/mpeg',
                          );
                          uploadedRefs.add(uploadedAudio.ref);
                          audioUrl = uploadedAudio.downloadUrl;
                        }

                        await docRef.set({
                          'id': docRef.id,
                          'locationName': locationName,
                          'imageUrl': imageUrl,
                          'soundUrl': audioUrl,
                          'createdAt': FieldValue.serverTimestamp(),
                          'updatedAt': FieldValue.serverTimestamp(),
                          'createdBy': widget.userEmail,
                        });

                        if (!mounted || !dialogContext.mounted) {
                          return;
                        }

                        dialogClosing = true;
                        Navigator.pop(dialogContext);
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                              content: Text(
                                  'Location "$locationName" saved successfully.')),
                        );
                      } catch (_) {
                        for (final ref in uploadedRefs) {
                          try {
                            await ref.delete();
                          } catch (_) {}
                        }

                        if (!mounted) {
                          return;
                        }

                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text(
                                'Failed to save location. Please try again.'),
                          ),
                        );
                      } finally {
                        if (dialogContext.mounted && !dialogClosing) {
                          setDialogState(() {
                            isSubmitting = false;
                          });
                        }
                      }
                    },
              child: isSubmitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Save'),
            ),
          ],
        ),
      ),
    ).whenComplete(() {
      locationController.dispose();
    });
    });
  }

  Future<void> _logout() async {
    await FirebaseAuth.instance.signOut();
    if (!mounted) {
      return;
    }

    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (context) => const LoginScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Admin Options'),
        centerTitle: true,
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: _logout,
            tooltip: 'Logout',
          ),
        ],
      ),
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            padding: const EdgeInsets.all(24.0),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: constraints.maxHeight),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
            Text(
              'Welcome, Admin (${widget.userEmail})',
              style: Theme.of(context).textTheme.titleLarge,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 40),
            Text(
              'Admin Options',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 20),
            ElevatedButton.icon(
              onPressed: _updateLocation,
              icon: const Icon(Icons.location_on),
              label: const Text('Update Location'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _sendGreeting,
              icon: const Icon(Icons.mail),
              label: const Text('Send Greeting'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _saveUserVoice,
              icon: const Icon(Icons.mic),
              label: const Text('Record My Voice'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _setGpsLocation,
              icon: const Icon(Icons.gps_fixed),
              label: const Text('Set GPS Location'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _addUser,
              icon: const Icon(Icons.person_add),
              label: const Text('Add User'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _addLocation,
              icon: const Icon(Icons.location_city),
              label: const Text('Add Location'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _removeUser,
              icon: const Icon(Icons.person_remove),
              label: const Text('Remove User'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _removeLocation,
              icon: const Icon(Icons.delete_outline),
              label: const Text('Remove Location'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _promptSomeone,
              icon: const Icon(Icons.notifications_active_outlined),
              label: const Text('Prompt Someone'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            _buildPromptInbox(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PickedUploadFile {
  const _PickedUploadFile({required this.name, required this.bytes});

  final String name;
  final Uint8List bytes;
}

enum _GreetingMediaSource {
  camera,
  gallery,
  recorder,
  audioFile,
}

enum _GreetingMediaType {
  voice,
  visual,
}

class _GreetingMediaSelection {
  const _GreetingMediaSelection({required this.file, required this.type});

  final _PickedUploadFile file;
  final _GreetingMediaType type;
}

class _UploadedLocationAsset {
  const _UploadedLocationAsset({required this.ref, required this.downloadUrl});

  final Reference ref;
  final String downloadUrl;
}

class _GpsCoordinate {
  const _GpsCoordinate({required this.latitude, required this.longitude});

  final double latitude;
  final double longitude;
}

class _ManagedLocation {
  const _ManagedLocation({
    required this.docId,
    required this.name,
    required this.imageUrl,
    required this.soundUrl,
  });

  final String docId;
  final String name;
  final String? imageUrl;
  final String? soundUrl;
}

class _ManagedUser {
  const _ManagedUser({
    required this.docId,
    required this.uid,
    required this.displayName,
    required this.email,
    required this.isEspUser,
  });

  final String docId;
  final String uid;
  final String displayName;
  final String? email;
  final bool isEspUser;
}

class _PromptRecipient {
  const _PromptRecipient({
    required this.uid,
    required this.displayName,
    required this.email,
  });

  final String uid;
  final String displayName;
  final String? email;
}

class _PromptComposeResult {
  const _PromptComposeResult({
    required this.recipient,
    required this.promptText,
    required this.scheduledFor,
  });

  final _PromptRecipient recipient;
  final String promptText;
  final DateTime scheduledFor;
}

class _PromptComposerDialog extends StatefulWidget {
  const _PromptComposerDialog({
    required this.recipients,
    required this.formatSchedule,
  });

  final List<_PromptRecipient> recipients;
  final String Function(BuildContext, DateTime) formatSchedule;

  @override
  State<_PromptComposerDialog> createState() => _PromptComposerDialogState();
}

class _PromptComposerDialogState extends State<_PromptComposerDialog> {
  final _formKey = GlobalKey<FormState>();
  final _promptController = TextEditingController();
  late String _selectedRecipientUid;
  late DateTime _scheduledFor;

  @override
  void initState() {
    super.initState();
    _selectedRecipientUid = widget.recipients.first.uid;
    _scheduledFor = DateTime.now().add(const Duration(minutes: 5));
  }

  @override
  void dispose() {
    _promptController.dispose();
    super.dispose();
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_scheduledFor),
    );
    if (picked == null || !mounted) {
      return;
    }

    final now = DateTime.now();
    var candidate = DateTime(
      now.year,
      now.month,
      now.day,
      picked.hour,
      picked.minute,
    );
    if (candidate.isBefore(now)) {
      candidate = candidate.add(const Duration(days: 1));
    }

    setState(() {
      _scheduledFor = candidate;
    });
  }

  @override
  Widget build(BuildContext context) {
    final selectedRecipient = widget.recipients.firstWhere(
      (recipient) => recipient.uid == _selectedRecipientUid,
      orElse: () => widget.recipients.first,
    );

    return AlertDialog(
      title: const Text('Prompt Someone'),
      content: SingleChildScrollView(
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DropdownButtonFormField<String>(
                value: _selectedRecipientUid,
                decoration: const InputDecoration(
                  labelText: 'User',
                  border: OutlineInputBorder(),
                ),
                items: widget.recipients
                    .map(
                      (recipient) => DropdownMenuItem<String>(
                        value: recipient.uid,
                        child: Text(recipient.displayName),
                      ),
                    )
                    .toList(),
                onChanged: (value) {
                  if (value == null) {
                    return;
                  }
                  setState(() {
                    _selectedRecipientUid = value;
                  });
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _promptController,
                maxLines: 3,
                textInputAction: TextInputAction.newline,
                decoration: const InputDecoration(
                  labelText: 'Prompt message',
                  border: OutlineInputBorder(),
                ),
                validator: (value) {
                  final prompt = value?.trim() ?? '';
                  if (prompt.isEmpty) {
                    return 'Prompt text is required';
                  }
                  if (prompt.length > 240) {
                    return 'Keep prompt under 240 characters';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _pickTime,
                icon: const Icon(Icons.schedule),
                label: Text(
                  'Schedule: ${widget.formatSchedule(context, _scheduledFor)}',
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'If the selected time already passed today, the prompt will be scheduled for tomorrow.',
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            if (!_formKey.currentState!.validate()) {
              return;
            }

            Navigator.pop(
              context,
              _PromptComposeResult(
                recipient: selectedRecipient,
                promptText: _promptController.text.trim(),
                scheduledFor: _scheduledFor,
              ),
            );
          },
          child: const Text('Send Prompt'),
        ),
      ],
    );
  }
}
