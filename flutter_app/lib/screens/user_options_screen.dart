import 'dart:async';
import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:file_picker/file_picker.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';
import 'package:latlong2/latlong.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'login_screen.dart';

class UserOptionsScreen extends StatefulWidget {
  final String userEmail;

  const UserOptionsScreen({super.key, required this.userEmail});

  @override
  State<UserOptionsScreen> createState() => _UserOptionsScreenState();
}

class _UserOptionsScreenState extends State<UserOptionsScreen> {
  final ImagePicker _imagePicker = ImagePicker();
  static const double _proximityRadiusMeters = 10;
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
    final serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      return;
    }

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }

    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      return;
    }

    _proximityTimer?.cancel();
    _checkAndUpdateNearbyLocation();
    _proximityTimer = Timer.periodic(
      const Duration(seconds: 20),
      (_) => _checkAndUpdateNearbyLocation(),
    );
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

      String? nearestLocation;
      double? nearestDistance;

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

        if (distance <= _proximityRadiusMeters &&
            (nearestDistance == null || distance < nearestDistance)) {
          nearestDistance = distance;
          nearestLocation = locationName;
        }
      }

      if (nearestLocation == null) {
        return;
      }

      final currentLocation = userData['currentLocation'] as String?;
      if (currentLocation == nearestLocation) {
        return;
      }

      await userRef.set({
        'currentLocation': nearestLocation,
        'lastUpdated': FieldValue.serverTimestamp(),
      }, SetOptions(merge: true));
    } catch (_) {
      // Ignore transient location/Firebase failures; periodic checks continue.
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
      if (!await recorder.hasPermission()) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Microphone permission is required.')),
          );
        }
        return null;
      }

      final tempDirectory = await getTemporaryDirectory();
      final path = '${tempDirectory.path}/voice_message_$timestamp.m4a';

      await recorder.start(
        const RecordConfig(
          encoder: AudioEncoder.aacLc,
          bitRate: 128000,
          sampleRate: 44100,
        ),
        path: path,
      );

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
        name: 'voice_message_$timestamp.m4a',
        bytes: bytes,
      );
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

  Future<List<String>> _fetchLocationNames() async {
    final snapshot = await FirebaseFirestore.instance
        .collection('locations')
        .orderBy('locationName')
        .get();

    final names = <String>{};
    for (final doc in snapshot.docs) {
      final name = doc.data()['locationName'];
      if (name is String && name.trim().isNotEmpty) {
        names.add(name.trim());
      }
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

  Future<_GpsCoordinate?> _showGpsPointPicker() async {
    LatLng? selectedPoint;
    const initialPoint = LatLng(31.7683, 35.2137);

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
      (a, b) =>
          a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()),
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

    return Expanded(
      child: Card(
        margin: const EdgeInsets.only(top: 20),
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

  Future<void> _setGpsLocation() async {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('You must be logged in to set GPS.')),
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

      final selectedPoint = await _showGpsPointPicker();
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

  void _logout() {
    FirebaseAuth.instance.signOut();
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (context) => const LoginScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('User Options'),
        centerTitle: true,
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: _logout,
            tooltip: 'Logout',
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Welcome, ${widget.userEmail}',
              style: Theme.of(context).textTheme.titleLarge,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 40),
            Text(
              'User Options',
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
              onPressed: _setGpsLocation,
              icon: const Icon(Icons.gps_fixed),
              label: const Text('Set GPS Location'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _promptSomeone,
              icon: const Icon(Icons.campaign),
              label: const Text('Prompt Someone'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            _buildPromptInbox(),
          ],
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
                initialValue: _selectedRecipientUid,
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
